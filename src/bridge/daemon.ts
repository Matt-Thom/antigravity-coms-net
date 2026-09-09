/**
 * src/bridge/daemon.ts
 *
 * BridgeDaemon: Unified coordinator for the Antigravity Coms-Net bridge.
 * Integrates:
 * - AgentLifecycle: AgentCard generation, registration & 10s heartbeat loop
 * - SseEventListener: resilient SSE connection with exponential backoff
 * - Inbound Queue: FIFO prompt queue, InboundContext, anti-loop prompt injection
 * - Turn Executor: ITurnExecutor execution (AgyCli or Mock)
 * - Response Submitter: schema validation and POST /v1/messages/:msg_id/response
 * - Signal Trapping: graceful shutdown on SIGINT/SIGTERM/beforeExit
 */

import { EventEmitter } from "node:events";
import type {
  AgentCard,
  InboundContext,
  InboundPromptEvent,
  InboundPromptPayload,
  ResponsePayload,
  ResponseSubmitRequest,
} from "../protocol/types.ts";
import { ComsNetClient } from "../protocol/client.ts";
import { ComsNetTools, type PendingReply } from "../protocol/tools.ts";
import { AgentLifecycle, type DynamicMetricProvider } from "./lifecycle.ts";
import { SseEventListener } from "./sse.ts";
import {
  type ITurnExecutor,
  AgyCliTurnExecutor,
  validateResponseSchema,
} from "./turn-executor.ts";
import { redactToken } from "../protocol/errors.ts";

export type DaemonStatus =
  | "uninitialized"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "error";

export interface BridgeDaemonOptions {
  client: ComsNetClient;
  turnExecutor?: ITurnExecutor;
  name?: string;
  purpose?: string;
  model?: string;
  provider?: string;
  color?: string;
  cwd?: string;
  explicit?: boolean;
  maxConcurrentTurns?: number;
  heartbeatIntervalMs?: number;
  autoTrapSignals?: boolean;
  fetchFn?: typeof fetch;
}

interface QueuedTurn {
  context: InboundContext;
  event: InboundPromptEvent;
}

export class BridgeDaemon extends EventEmitter {
  public readonly client: ComsNetClient;
  public readonly turnExecutor: ITurnExecutor;
  public status: DaemonStatus = "uninitialized";

  public readonly lifecycle: AgentLifecycle;
  private sse: SseEventListener | null = null;
  private readonly options: BridgeDaemonOptions;
  private identity: AgentCard | null = null;

  private readonly inboundQueue = new Map<string, InboundContext>();
  private readonly turnFifo: QueuedTurn[] = [];
  private activeTurns = 0;
  private currentInbound: InboundContext | null = null;
  private readonly maxConcurrentTurns: number;

  public readonly pendingReplies = new Map<string, PendingReply>();
  private tools: ComsNetTools | null = null;

  private boundSigint: (() => void) | null = null;
  private boundSigterm: (() => void) | null = null;
  private boundBeforeExit: (() => void) | null = null;

  constructor(options: BridgeDaemonOptions) {
    super();
    this.options = options;
    this.client = options.client;
    this.turnExecutor = options.turnExecutor ?? new AgyCliTurnExecutor();
    this.maxConcurrentTurns = Math.max(1, options.maxConcurrentTurns ?? 1);

    this.lifecycle = new AgentLifecycle({
      client: this.client,
      name: options.name,
      purpose: options.purpose,
      model: options.model,
      provider: options.provider,
      color: options.color,
      cwd: options.cwd,
      explicit: options.explicit,
      heartbeatIntervalMs: options.heartbeatIntervalMs,
      autoInstallSignalHandlers: false, // Managed by daemon
    });

    if (options.autoTrapSignals) {
      this.registerSignalHandlers();
    }
  }

  // ━━ Inbound Context Manager for ComsNetTools ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  public getInboundContextManager() {
    return {
      getCurrentInbound: () => this.currentInbound,
      setCurrentInbound: (ctx: InboundContext | null) => {
        this.currentInbound = ctx;
      },
      getInbound: (msg_id: string) => this.inboundQueue.get(msg_id),
      removeInbound: (msg_id: string) => {
        this.inboundQueue.delete(msg_id);
      },
    };
  }

  public getTools(): ComsNetTools {
    if (!this.tools) {
      const card = this.getIdentity();
      if (!card) {
        throw new Error("BridgeDaemon must be started before accessing tools");
      }
      this.tools = new ComsNetTools({
        client: this.client,
        identity: {
          session_id: card.session_id,
          name: card.name,
          project: card.project,
          cwd: card.cwd,
        },
        pendingReplies: this.pendingReplies,
        inboundContextManager: this.getInboundContextManager(),
      });
    }
    return this.tools;
  }

  public getIdentity(): AgentCard | null {
    return this.lifecycle.getCard() ?? this.identity;
  }

  public getInboundQueueSize(): number {
    return this.inboundQueue.size;
  }

  // ━━ Start & Registration ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  async start(): Promise<AgentCard> {
    if (this.status === "running" || this.status === "starting") {
      throw new Error(`BridgeDaemon is already ${this.status}`);
    }

    this.status = "starting";
    this.emit("status", this.status);

    // Provide dynamic metrics to lifecycle
    const metricProvider: DynamicMetricProvider = () => ({
      queue_depth: this.inboundQueue.size,
    });
    this.lifecycle.setMetricProvider(metricProvider);

    // Forward lifecycle events
    this.lifecycle.on("name_collision", (data) => this.emit("name_collision", data));
    this.lifecycle.on("heartbeat", (data) => this.emit("heartbeat", data));
    this.lifecycle.on("heartbeat_failed", (data) => this.emit("heartbeat_failed", data));
    this.lifecycle.on("re_registered", (data) => this.emit("re_registered", data));

    // Start lifecycle (registration + heartbeat timer)
    const regResp = await this.lifecycle.start();
    this.identity = regResp.agent;

    // Connect SSE stream
    this.sse = new SseEventListener({
      baseUrl: this.client.baseUrl,
      authToken: this.client.authToken,
      project: this.identity.project,
      sessionId: this.identity.session_id,
      fetchFn: this.options.fetchFn,
      registerFn: () => this.lifecycle.reRegister(),
    });

    this.sse.on("prompt", (payload: InboundPromptPayload) => {
      this.handleInboundPrompt(payload);
    });

    this.sse.on("response", (payload: ResponsePayload) => {
      this.handleInboundResponse(payload);
    });

    this.sse.on("connected", () => this.emit("sse_connected"));
    this.sse.on("disconnected", (reason, err) => this.emit("sse_disconnected", reason, err));
    this.sse.on("ping", (ts) => this.emit("ping", ts));

    // Forward remaining hub events
    for (const evt of [
      "hello",
      "pool_snapshot",
      "agent_joined",
      "agent_updated",
      "agent_stale",
      "agent_left",
      "message_status",
      "error",
    ]) {
      this.sse.on(evt, (data) => this.emit(evt, data));
    }

    await this.sse.start();

    this.status = "running";
    this.emit("status", this.status);
    this.emit("started", this.identity);

    return this.identity;
  }

  // ━━ Inbound Prompt Handling ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  private handleInboundPrompt(payload: InboundPromptPayload): void {
    if (!payload?.msg_id || !payload?.prompt) return;

    // Deduplication
    if (this.inboundQueue.has(payload.msg_id)) {
      return;
    }

    const context: InboundContext = {
      msg_id: payload.msg_id,
      hops: typeof payload.hops === "number" ? payload.hops : 0,
      sender_session: payload.sender?.session_id ?? "unknown",
      sender_name: payload.sender?.name ?? "unknown",
      sender_cwd: payload.sender?.cwd ?? "?",
      prompt: payload.prompt,
      conversation_id: payload.conversation_id,
      response_schema: payload.response_schema,
      fulfilled: false,
    };

    const event: InboundPromptEvent = {
      msg_id: payload.msg_id,
      sender_session: context.sender_session,
      sender_name: context.sender_name,
      sender_project: payload.project ?? this.client.project,
      prompt: payload.prompt,
      conversation_id: payload.conversation_id ?? undefined,
      response_schema: payload.response_schema ?? undefined,
      hops: context.hops,
    };

    this.inboundQueue.set(payload.msg_id, context);
    this.turnFifo.push({ context, event });
    this.emit("prompt_received", event);

    this.drainTurnQueue();
  }

  private drainTurnQueue(): void {
    if (this.activeTurns >= this.maxConcurrentTurns || this.turnFifo.length === 0) {
      return;
    }

    const item = this.turnFifo.shift();
    if (!item) return;

    this.activeTurns++;
    this.processTurn(item).finally(() => {
      this.activeTurns--;
      this.drainTurnQueue();
    });
  }

  private async processTurn(item: QueuedTurn): Promise<void> {
    const { context, event } = item;
    this.currentInbound = context;

    try {
      this.emit("turn_started", event);
      const turnResult = await this.turnExecutor.execute(event);

      let finalPayload: unknown = turnResult.response;
      let finalError: string | null = turnResult.error ?? null;

      if (!finalError && context.response_schema) {
        const validated = validateResponseSchema(turnResult.response, context.response_schema);
        finalPayload = validated.payload;
        finalError = validated.error;
      }

      const card = this.getIdentity();
      if (card) {
        const body: ResponseSubmitRequest = {
          project: card.project,
          responder_session: card.session_id,
          response: finalPayload,
          error: finalError,
        };
        await this.client.submitResponse(context.msg_id, body);
        this.emit("response_submitted", { msg_id: context.msg_id, ok: true });
      }
    } catch (err: unknown) {
      this.emit("turn_error", { msg_id: context.msg_id, error: err });
      const card = this.getIdentity();
      if (card) {
        try {
          await this.client.submitResponse(context.msg_id, {
            project: card.project,
            responder_session: card.session_id,
            error: redactToken(err instanceof Error ? err.message : String(err)),
          });
        } catch {
          // Best-effort error submission
        }
      }
    } finally {
      context.fulfilled = true;
      this.inboundQueue.delete(context.msg_id);
      if (this.currentInbound?.msg_id === context.msg_id) {
        this.currentInbound = null;
      }
      this.emit("turn_completed", { msg_id: context.msg_id });
    }
  }

  private handleInboundResponse(payload: ResponsePayload): void {
    if (!payload?.msg_id) return;
    const pending = this.pendingReplies.get(payload.msg_id);
    if (pending) {
      pending.result = {
        response: payload.response,
        error: payload.error,
      };
      try {
        pending.resolve(pending.result);
      } catch {
        // Already settled
      }
    }
  }

  // ━━ Signal Handlers & Graceful Shutdown ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  public registerSignalHandlers(): void {
    this.boundSigint = () => {
      this.stop().then(() => process.exit(0)).catch(() => process.exit(1));
    };
    this.boundSigterm = () => {
      this.stop().then(() => process.exit(0)).catch(() => process.exit(1));
    };
    this.boundBeforeExit = () => {
      if (this.status === "running") {
        this.stop().catch(() => {});
      }
    };

    process.once("SIGINT", this.boundSigint);
    process.once("SIGTERM", this.boundSigterm);
    process.once("beforeExit", this.boundBeforeExit);
  }

  public unregisterSignalHandlers(): void {
    if (this.boundSigint) {
      process.removeListener("SIGINT", this.boundSigint);
      this.boundSigint = null;
    }
    if (this.boundSigterm) {
      process.removeListener("SIGTERM", this.boundSigterm);
      this.boundSigterm = null;
    }
    if (this.boundBeforeExit) {
      process.removeListener("beforeExit", this.boundBeforeExit);
      this.boundBeforeExit = null;
    }
  }

  async stop(): Promise<void> {
    if (this.status === "stopping" || this.status === "stopped") {
      return;
    }

    this.status = "stopping";
    this.emit("status", this.status);

    this.unregisterSignalHandlers();

    // 1. Close SSE stream
    if (this.sse) {
      try {
        await this.sse.stop();
      } catch {
        // Best effort
      }
      this.sse = null;
    }

    // 2. Stop lifecycle (clears heartbeat timer and calls DELETE /v1/agents/:session_id)
    try {
      await this.lifecycle.stop();
    } catch {
      // Best effort
    }

    // 3. Clear queues
    this.inboundQueue.clear();
    this.turnFifo.length = 0;
    this.currentInbound = null;

    this.status = "stopped";
    this.emit("status", this.status);
    this.emit("stopped");
  }
}
