/**
 * src/bridge/lifecycle.ts
 *
 * Antigravity Agent Lifecycle & Heartbeat Daemon.
 * Manages agent identity synthesis, registration, 10s heartbeat loop,
 * dynamic metrics reporting, auto-re-registration on purge, and graceful exit.
 */

import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
import type {
  AgentCard,
  AgentStatus,
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
} from "../protocol/types.ts";
import {
  ComsNetClient,
  AgentNotFoundError,
  UnauthorizedError,
  ComsNetHttpError,
  ComsNetError,
} from "../protocol/client.ts";
import { generateUlid } from "../protocol/tools.ts";

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000;
export const SHUTDOWN_DELETE_TIMEOUT_MS = 2_000;

export const NEON_PALETTE = [
  "#72F1B8", // Mint green
  "#36F9F6", // Cyan
  "#FF7EDB", // Pink
  "#FEDE5D", // Yellow
  "#C792EA", // Purple
  "#FF8B39", // Orange
  "#4D9DE0", // Blue
  "#FFAA8B", // Peach
] as const;

export type LifecycleState =
  | "unregistered"
  | "registered"
  | "active"
  | "stopping"
  | "stopped";

export type DynamicMetricProvider = () =>
  | Partial<HeartbeatRequest>
  | Promise<Partial<HeartbeatRequest>>;

export interface AgentIdentity {
  session_id: string;
  name: string;
  project: string;
  purpose: string;
  model: string;
  provider: string;
  color: string;
  cwd: string;
  explicit: boolean;
  runtime: string;
  started_at: string;
}

export interface LifecycleOptions {
  client: ComsNetClient;
  project?: string;
  sessionId?: string;
  name?: string;
  purpose?: string;
  model?: string;
  provider?: string;
  color?: string;
  cwd?: string;
  explicit?: boolean;
  runtime?: string;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  metricProvider?: DynamicMetricProvider;
  autoInstallSignalHandlers?: boolean;
}

export function isValidHexColor(color: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(color);
}

export function generateDeterministicColor(sessionId: string): string {
  const hash = crypto.createHash("sha256").update(sessionId).digest();
  return NEON_PALETTE[hash[0] % NEON_PALETTE.length];
}

export class AgentLifecycle extends EventEmitter {
  private readonly client: ComsNetClient;
  private readonly options: LifecycleOptions;
  private identity: AgentIdentity;
  private card: AgentCard | null = null;
  private state: LifecycleState = "unregistered";
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatIntervalMs: number;
  private heartbeatTimeoutMs: number;
  private sseUrl: string | null = null;
  private consecutiveFailures = 0;
  private isHeartbeatInFlight = false;
  private signalCleanup: (() => void) | null = null;
  private metricProvider?: DynamicMetricProvider;

  constructor(options: LifecycleOptions) {
    super();
    this.options = options;
    this.client = options.client;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.metricProvider = options.metricProvider;

    const sessionId = options.sessionId || generateUlid();
    const project = options.project || this.client.project || "default";
    const defaultName = `antigravity-${sessionId.slice(-6).toLowerCase()}`;
    const name = options.name || process.env.AGY_AGENT_NAME || process.env.COMS_NET_AGENT_NAME || defaultName;
    const purpose = options.purpose || process.env.COMS_NET_AGENT_PURPOSE || "Antigravity CLI peer agent";
    const model = options.model || process.env.AGY_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-pro";
    const provider = options.provider || "google";

    let color = generateDeterministicColor(sessionId);
    if (options.color && isValidHexColor(options.color)) {
      color = options.color;
    }

    const cwd = options.cwd || process.cwd();
    const explicit = options.explicit === true;
    const runtime = options.runtime || "antigravity";
    const started_at = new Date().toISOString();

    this.identity = {
      session_id: sessionId,
      name,
      project,
      purpose,
      model,
      provider,
      color,
      cwd,
      explicit,
      runtime,
      started_at,
    };
  }

  getIdentity(): Readonly<AgentIdentity> {
    return { ...this.identity };
  }

  getCard(): Readonly<AgentCard> | null {
    return this.card ? { ...this.card } : null;
  }

  getState(): LifecycleState {
    return this.state;
  }

  getHeartbeatIntervalMs(): number {
    return this.heartbeatIntervalMs;
  }

  getSseUrl(): string | null {
    return this.sseUrl;
  }

  setMetricProvider(provider: DynamicMetricProvider): void {
    this.metricProvider = provider;
  }

  async start(): Promise<RegisterResponse> {
    if (this.state === "active") {
      throw new ComsNetError("AgentLifecycle is already active");
    }

    const regResp = await this.register();

    if (this.options.autoInstallSignalHandlers) {
      this.installSignalHandlers();
    }

    this.startHeartbeatTimer();
    this.state = "active";
    return regResp;
  }

  async register(): Promise<RegisterResponse> {
    const req: RegisterRequest = {
      project: this.identity.project,
      session_id: this.identity.session_id,
      name: this.identity.name,
      purpose: this.identity.purpose,
      model: this.identity.model,
      provider: this.identity.provider,
      color: this.identity.color,
      cwd: this.identity.cwd,
      explicit: this.identity.explicit,
      runtime: this.identity.runtime,
    };

    const resp = await this.client.registerAgent(req, { timeoutMs: 10_000 });
    if (!resp || !resp.agent) {
      throw new ComsNetError("Malformed register response from coms-net hub");
    }

    // Name collision deconfliction: adopt server assigned name
    if (resp.agent.name !== this.identity.name) {
      const desired = this.identity.name;
      const assigned = resp.agent.name;
      this.identity.name = assigned;
      this.emit("name_collision", { desired, assigned });
    }

    this.card = resp.agent;
    if (typeof resp.heartbeat_interval_ms === "number" && resp.heartbeat_interval_ms > 0) {
      this.heartbeatIntervalMs = resp.heartbeat_interval_ms;
    }
    this.sseUrl = resp.sse_url;
    this.consecutiveFailures = 0;
    this.state = "registered";

    this.emit("registered", resp);
    return resp;
  }

  async reRegister(): Promise<RegisterResponse> {
    const resp = await this.register();
    this.emit("re_registered", resp);
    return resp;
  }

  async sendHeartbeat(): Promise<boolean> {
    if (!this.card || this.state === "stopped" || this.state === "stopping") {
      return false;
    }

    if (this.isHeartbeatInFlight) {
      return false; // Skip tick to prevent concurrency pileup
    }

    this.isHeartbeatInFlight = true;
    try {
      let dynamicMetrics: Partial<HeartbeatRequest> = {};
      const provider = this.metricProvider ?? this.options.metricProvider;
      if (provider) {
        try {
          dynamicMetrics = (await provider()) || {};
        } catch (err) {
          this.emit("error", new ComsNetError(
            `DynamicMetricProvider failed: ${err instanceof Error ? err.message : String(err)}`
          ));
        }
      }

      const hbReq: HeartbeatRequest = {
        project: this.card.project,
        context_used_pct: dynamicMetrics.context_used_pct ?? this.card.context_used_pct,
        queue_depth: dynamicMetrics.queue_depth ?? this.card.queue_depth,
        model: dynamicMetrics.model ?? this.card.model,
        status: dynamicMetrics.status ?? (this.card.status as AgentStatus) ?? "online",
      };

      await this.client.sendHeartbeat(this.identity.session_id, hbReq, {
        timeoutMs: this.heartbeatTimeoutMs,
      });

      // Update cached card values
      if (typeof hbReq.context_used_pct === "number") this.card.context_used_pct = hbReq.context_used_pct;
      if (typeof hbReq.queue_depth === "number") this.card.queue_depth = hbReq.queue_depth;
      if (typeof hbReq.model === "string") this.card.model = hbReq.model;
      if (hbReq.status) this.card.status = hbReq.status;
      this.card.last_seen_at = Date.now();

      this.consecutiveFailures = 0;
      this.emit("heartbeat", { timestamp: Date.now(), metrics: hbReq });
      return true;
    } catch (err: unknown) {
      this.consecutiveFailures++;

      // 404 Agent Not Found -> Re-registration
      const isAgentNotFound =
        err instanceof AgentNotFoundError ||
        (err instanceof ComsNetHttpError && err.status === 404) ||
        (err as { code?: string })?.code === "agent_not_found";

      if (isAgentNotFound) {
        this.emit("heartbeat_failed", {
          error: err instanceof Error ? err : new Error(String(err)),
          consecutiveFailures: this.consecutiveFailures,
          reason: "purged",
        });

        try {
          await this.reRegister();
          this.consecutiveFailures = 0;
          return true;
        } catch (reRegErr) {
          this.emit("error", new ComsNetError(
            `Re-registration after purge failed: ${reRegErr instanceof Error ? reRegErr.message : String(reRegErr)}`
          ));
          return false;
        }
      }

      // 401 Unauthorized -> Fatal
      const isUnauthorized =
        err instanceof UnauthorizedError ||
        (err instanceof ComsNetHttpError && err.status === 401);

      if (isUnauthorized) {
        this.emit("error", new ComsNetError("Heartbeat 401 unauthorized. Stopping heartbeat."));
        this.stopHeartbeatTimer();
        return false;
      }

      // Stale warning threshold
      if (this.consecutiveFailures >= 3) {
        this.emit("heartbeat_stale_warning", {
          consecutiveFailures: this.consecutiveFailures,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }

      // Transient blip
      this.emit("heartbeat_failed", {
        error: err instanceof Error ? err : new Error(String(err)),
        consecutiveFailures: this.consecutiveFailures,
        reason: "network_blip",
      });
      return false;
    } finally {
      this.isHeartbeatInFlight = false;
    }
  }

  async stop(): Promise<void> {
    if (this.state === "stopped" || this.state === "stopping") {
      return;
    }

    this.state = "stopping";
    this.stopHeartbeatTimer();

    if (this.signalCleanup) {
      this.signalCleanup();
      this.signalCleanup = null;
    }

    try {
      await this.client.deleteAgent(
        this.identity.session_id,
        { project: this.identity.project },
        { timeoutMs: SHUTDOWN_DELETE_TIMEOUT_MS }
      );
    } catch {
      // Best-effort shutdown; do not throw on delete failure
    }

    this.state = "stopped";
    this.emit("unregistered");
  }

  private startHeartbeatTimer(): void {
    this.stopHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat();
    }, this.heartbeatIntervalMs);

    try {
      this.heartbeatTimer.unref?.();
    } catch {
      // Non-Node environments ignore unref
    }
  }

  private stopHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private installSignalHandlers(): void {
    const onSigint = () => {
      void this.stop().then(() => process.exit(0));
    };
    const onSigterm = () => {
      void this.stop().then(() => process.exit(0));
    };

    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    this.signalCleanup = () => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };
  }
}
