/**
 * src/protocol/tools.ts
 *
 * Core coms-net client tools implementation:
 * - coms_net_list: active peer discovery with caller filtering and status formatting
 * - coms_net_send: message dispatch with ULID generation, hop limit check (hops >= 5), pendingReplies tracking
 * - coms_net_get: fast-path SSE cache lookup falling back to HTTP GET /v1/messages/:id
 * - coms_net_await: 3-way race (local SSE promise, HTTP await long-poll, client timeout) with immediate abort
 */

import * as crypto from "node:crypto";
import type {
  AgentCard,
  ToolResult,
  ToolListParams,
  ToolListResult,
  ToolSendParams,
  ToolSendResult,
  ToolGetParams,
  ToolGetResult,
  ToolAwaitParams,
  ToolAwaitResult,
  InboundContext,
} from "./types.ts";
import { HopLimitExceededError } from "./errors.ts";

export type { InboundContext };

// ━━ Constants ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const MAX_HOPS = 5;
export const DEFAULT_AWAIT_TIMEOUT_MS = 1_800_000; // 30 minutes

// ━━ Utility Functions ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Generates a 26-character Crockford Base32 ULID without external dependencies.
 * Format: 10-char millisecond timestamp + 16-char cryptographically secure randomness.
 */
export function generateUlid(now: number = Date.now()): string {
  const rand = crypto.randomBytes(10);
  let timeStr = "";
  let t = now;
  for (let i = 9; i >= 0; i--) {
    timeStr = CROCKFORD_ALPHABET[t % 32] + timeStr;
    t = Math.floor(t / 32);
  }
  let randStr = "";
  let bits = 0;
  let value = 0;
  for (const byte of rand) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      randStr += CROCKFORD_ALPHABET[(value >> bits) & 31];
    }
  }
  return (timeStr + randStr).slice(0, 26);
}

/**
 * Abbreviates model IDs for compact display.
 */
export function abbreviateModel(model?: string): string {
  let m = model || "";
  if (m.startsWith("claude-")) m = m.slice("claude-".length);
  if (m.length > 14) m = m.slice(0, 14);
  return m;
}

/**
 * Formats a list of peer agents into compact human-readable text.
 */
export function formatPeerRoster(peers: AgentCard[]): string {
  if (peers.length === 0) {
    return "No peer agents found.";
  }
  return peers
    .map((a) => {
      const live = a.status === "online" ? "●" : a.status === "stale" ? "~" : "✗";
      const ctxStr = typeof a.context_used_pct === "number" ? ` ${a.context_used_pct}%` : " ?%";
      const purposeStr = a.purpose ? ` — ${a.purpose}` : "";
      return `${live} ${a.name} (${abbreviateModel(a.model)})${ctxStr}${purposeStr}`;
    })
    .join("\n");
}

// ━━ Tool Support Types ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface PendingReplyResult {
  response?: unknown;
  error?: string | null;
}

export interface PendingReply {
  resolve: (value: PendingReplyResult) => void;
  reject: (err: Error) => void;
  promise: Promise<PendingReplyResult>;
  result?: PendingReplyResult;
  target_name?: string;
  target_session?: string;
  created_at: string;
}

export interface IComsClient {
  getAgents(
    project?: string,
    includeExplicit?: boolean
  ): Promise<{ agents: AgentCard[] }>;
  sendMessage(params: {
    project: string;
    sender_session: string;
    target: string;
    target_session: string | null;
    prompt: string;
    conversation_id: string | null;
    response_schema: Record<string, unknown> | null;
    hops: number;
  }): Promise<{
    ok: boolean;
    msg_id: string;
    status: "queued" | "delivered";
    target_session: string;
  }>;
  getMessage(msg_id: string): Promise<{
    msg_id: string;
    status: "queued" | "delivered" | "complete" | "error" | "timeout";
    response: unknown | null;
    error: string | null;
  }>;
  awaitMessage(
    msg_id: string,
    paramsOrTimeout?: number | { timeout_ms?: number },
    signalOrOpts?: AbortSignal | { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<{
    msg_id: string;
    status: "complete" | "error" | "timeout";
    response: unknown | null;
    error: string | null;
  }>;
}

export interface ToolContext {
  client: IComsClient;
  identity: {
    session_id: string;
    name: string;
    project: string;
    cwd?: string;
  };
  pendingReplies: Map<string, PendingReply>;
  inboundContextManager?: {
    getCurrentInbound(): InboundContext | null;
    setCurrentInbound(ctx: InboundContext | null): void;
    getInbound(msg_id: string): InboundContext | undefined;
    removeInbound(msg_id: string): void;
  };
  maxHops?: number;
  defaultAwaitTimeoutMs?: number;
}

// ━━ Core Tools Implementation Class ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class ComsNetTools {
  private readonly ctx: ToolContext;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
  }

  /**
   * coms_net_list: Discovers peer agents on the coms-net hub for a project.
   * Filters out caller's own session ID and formats peer roster.
   */
  async list(params: ToolListParams = {}): Promise<ToolListResult> {
    if (!this.ctx.identity?.session_id) {
      throw new Error("coms-net not initialized");
    }

    const project = params.project ?? this.ctx.identity.project;
    const includeExplicit = params.include_explicit === true;

    const resp = await this.ctx.client.getAgents(project, includeExplicit);
    const agents = Array.isArray(resp?.agents) ? resp.agents : [];
    const peers = agents.filter(
      (a) => a.session_id !== this.ctx.identity.session_id
    );

    const rosterText = formatPeerRoster(peers);
    const text = `${peers.length} peer(s):\n${rosterText}`;

    return {
      content: [{ type: "text", text }],
      details: { project, agents: peers },
    };
  }

  /**
   * coms_net_send: Initiates a new outbound message to a peer agent.
   * Enforces hop limit (hops >= 5 throws HopLimitExceededError),
   * generates ULID, and tracks message in pendingReplies.
   */
  async send(params: ToolSendParams & { hops?: number }): Promise<ToolSendResult> {
    if (!this.ctx.identity?.session_id) {
      throw new Error("coms-net not initialized");
    }

    const target = (params.target ?? "").trim();
    if (!target) {
      throw new Error("coms-net: target must not be empty");
    }

    const prompt = (params.prompt ?? "").trim();
    if (!prompt) {
      throw new Error("coms-net: prompt must not be empty");
    }

    // Inbound context hop calculation & limit enforcement
    const currentInbound = this.ctx.inboundContextManager?.getCurrentInbound();
    const hops =
      typeof params.hops === "number"
        ? params.hops
        : currentInbound
        ? currentInbound.hops + 1
        : 0;
    const maxHops = this.ctx.maxHops ?? MAX_HOPS;

    if (hops >= maxHops) {
      throw new HopLimitExceededError(
        409,
        "hop_limit_exceeded",
        { hops, max_hops: maxHops },
        "POST",
        "/v1/messages"
      );
    }

    // Client-side ULID generation for idempotency and tracing
    const clientGeneratedUlid = generateUlid();

    const resp = await this.ctx.client.sendMessage({
      project: this.ctx.identity.project,
      sender_session: this.ctx.identity.session_id,
      target,
      target_session: null,
      prompt,
      conversation_id: params.conversation_id ?? null,
      response_schema: params.response_schema ?? null,
      hops,
    });

    const msgId = resp.msg_id || clientGeneratedUlid;

    // Register pending reply promise for local SSE resolution
    let resolveFn!: (v: PendingReplyResult) => void;
    let rejectFn!: (e: Error) => void;
    const promise = new Promise<PendingReplyResult>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });

    this.ctx.pendingReplies.set(msgId, {
      resolve: resolveFn,
      reject: rejectFn,
      promise,
      target_name: target,
      target_session: resp.target_session,
      created_at: new Date().toISOString(),
    });

    return {
      content: [
        {
          type: "text",
          text: `coms_net_send → ${target}\nmsg_id ${msgId}\nhops ${hops}`,
        },
      ],
      details: {
        msg_id: msgId,
        target,
        target_session: resp.target_session,
        hops,
        status: resp.status,
      },
    };
  }

  /**
   * coms_net_get: Non-blocking inspection of message reply.
   * Checks fast-path in-memory pendingReplies cache first,
   * falling back to HTTP GET /v1/messages/:msg_id.
   */
  async get(params: ToolGetParams): Promise<ToolGetResult> {
    const msgId = (params.msg_id ?? "").trim();
    if (!msgId) {
      throw new Error("coms-net: msg_id must not be empty");
    }

    // Fast path: In-memory SSE-resolved cache
    const pending = this.ctx.pendingReplies.get(msgId);
    if (pending?.result) {
      const r = pending.result;
      const text = r.error
        ? `coms_net_get: error — ${r.error}`
        : `coms_net_get: complete\n${
            typeof r.response === "string"
              ? r.response
              : JSON.stringify(r.response, null, 2)
          }`;

      return {
        content: [{ type: "text", text }],
        details: {
          status: r.error ? "error" : "complete",
          response: r.response,
          error: r.error ?? null,
        },
      };
    }

    // Fallback path: HTTP REST call
    let resp: {
      msg_id: string;
      status: "queued" | "delivered" | "complete" | "error" | "timeout";
      response: unknown | null;
      error: string | null;
    };

    try {
      resp = await this.ctx.client.getMessage(msgId);
    } catch (err: unknown) {
      const errorObj = err as { status?: number; message?: string };
      if (errorObj?.status === 404 || errorObj?.message?.includes("404") || errorObj?.message?.includes("not found")) {
        return {
          content: [
            { type: "text", text: `coms_net_get: unknown msg_id ${msgId}` },
          ],
          details: { status: "error", error: "unknown msg_id" },
          isError: true,
        };
      }
      throw err;
    }

    const status = resp.status ?? "queued";
    if (status === "complete" || status === "error" || status === "timeout") {
      const text = resp.error
        ? `coms_net_get: ${status} — ${resp.error}`
        : `coms_net_get: ${status}\n${
            typeof resp.response === "string"
              ? resp.response
              : JSON.stringify(resp.response, null, 2)
          }`;

      // Cache result locally
      if (pending) {
        pending.result = { response: resp.response, error: resp.error };
      }

      return {
        content: [{ type: "text", text }],
        details: {
          status,
          response: resp.response,
          error: resp.error ?? null,
        },
      };
    }

    return {
      content: [{ type: "text", text: `coms_net_get: ${status}` }],
      details: { status },
    };
  }

  /**
   * coms_net_await: Suspends until reply arrives via a 3-way race:
   * 1. Local SSE push event promise
   * 2. Server HTTP long-poll GET /v1/messages/:id/await
   * 3. Client timeout timer
   * Immediately aborts the HTTP long-poll upon settling to release sockets.
   */
  async await(params: ToolAwaitParams): Promise<ToolAwaitResult> {
    const msgId = (params.msg_id ?? "").trim();
    if (!msgId) {
      throw new Error("coms-net: msg_id must not be empty");
    }

    const defaultTimeout =
      this.ctx.defaultAwaitTimeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;
    const timeoutMs =
      typeof params.timeout_ms === "number" && params.timeout_ms > 0
        ? params.timeout_ms
        : defaultTimeout;

    // Fast path: In-memory SSE cache check
    const pending = this.ctx.pendingReplies.get(msgId);
    if (pending?.result) {
      const r = pending.result;
      if (r.error) {
        return {
          content: [
            { type: "text", text: `coms_net_await: error — ${r.error}` },
          ],
          details: { error: r.error, status: "error" },
          isError: true,
        };
      }
      const resp = r.response;
      return {
        content: [
          {
            type: "text",
            text:
              typeof resp === "string"
                ? resp
                : JSON.stringify(resp, null, 2),
          },
        ],
        details: { response: resp, status: "complete" },
      };
    }

    // ━━ Competitor 1: Local SSE Promise ━━
    let localPromise: Promise<PendingReplyResult>;
    if (pending) {
      localPromise = pending.promise;
    } else {
      let resolveFn!: (v: PendingReplyResult) => void;
      let rejectFn!: (e: Error) => void;
      const prom = new Promise<PendingReplyResult>((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
      });
      const newPending: PendingReply = {
        resolve: resolveFn,
        reject: rejectFn,
        promise: prom,
        created_at: new Date().toISOString(),
      };
      this.ctx.pendingReplies.set(msgId, newPending);
      localPromise = prom;
    }

    // ━━ Competitor 2: Server HTTP Long-Poll with AbortController ━━
    const ac = new AbortController();
    const serverTimeoutMs = Math.min(timeoutMs, defaultTimeout);
    const serverPromise: Promise<PendingReplyResult> = this.ctx.client
      .awaitMessage(msgId, serverTimeoutMs, ac.signal)
      .then((data) => {
        if (data.status === "complete") {
          return { response: data.response, error: null };
        }
        if (data.status === "error") {
          return { response: null, error: data.error ?? "error" };
        }
        if (data.status === "timeout") {
          return { response: null, error: "timeout" };
        }
        return { response: data.response, error: data.error ?? null };
      })
      .catch((err: unknown) => {
        const errorObj = err as { name?: string; status?: number; message?: string };
        if (errorObj?.name === "AbortError" || ac.signal.aborted) {
          return { response: null, error: "aborted" };
        }
        if (errorObj?.status === 404 || errorObj?.message?.includes("404")) {
          return { response: null, error: "unknown msg_id" };
        }
        return { response: null, error: errorObj?.message ?? "network_error" };
      });

    // ━━ Competitor 3: Client Timeout Timer ━━
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<PendingReplyResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({ response: null, error: "timeout" });
      }, timeoutMs);
      try {
        (timer as { unref?: () => void }).unref?.();
      } catch {
        // ignore
      }
    });

    try {
      const winner = await Promise.race([
        localPromise,
        serverPromise,
        timeoutPromise,
      ]);

      // Abort HTTP request immediately upon settling!
      try {
        ac.abort();
      } catch {
        // ignore
      }

      // Cache result if not aborted
      if (winner && winner.error !== "aborted") {
        const targetPending = this.ctx.pendingReplies.get(msgId);
        if (targetPending) {
          targetPending.result = winner;
        }
      }

      if (winner.error && winner.error !== "aborted") {
        const status = winner.error === "timeout" ? "timeout" : "error";
        return {
          content: [
            {
              type: "text",
              text: `coms_net_await: ${status} — ${winner.error}`,
            },
          ],
          details: { error: winner.error, status },
          isError: true,
        };
      }

      const resp = winner.response;
      return {
        content: [
          {
            type: "text",
            text:
              typeof resp === "string"
                ? resp
                : JSON.stringify(resp, null, 2),
          },
        ],
        details: { response: resp, status: "complete" },
      };
    } finally {
      if (timer) clearTimeout(timer);
      try {
        ac.abort();
      } catch {
        // ignore
      }
    }
  }
}

// ━━ Top-Level Functional Wrappers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function coms_net_list(
  ctx: ToolContext,
  params: ToolListParams = {}
): Promise<ToolListResult> {
  return new ComsNetTools(ctx).list(params);
}

export async function coms_net_send(
  ctx: ToolContext,
  params: ToolSendParams & { hops?: number }
): Promise<ToolSendResult> {
  return new ComsNetTools(ctx).send(params);
}

export async function coms_net_get(
  ctx: ToolContext,
  params: ToolGetParams
): Promise<ToolGetResult> {
  return new ComsNetTools(ctx).get(params);
}

export async function coms_net_await(
  ctx: ToolContext,
  params: ToolAwaitParams
): Promise<ToolAwaitResult> {
  return new ComsNetTools(ctx).await(params);
}
