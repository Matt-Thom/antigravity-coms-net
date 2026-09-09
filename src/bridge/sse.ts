/**
 * src/bridge/sse.ts
 *
 * Antigravity Coms-Net SSE Streaming & Reconnection Engine.
 * Implements:
 * - SseParser: Zero-dependency WHATWG ReadableStream chunk decoder and frame parser.
 * - SseEventListener: Persistent event listener with exponential backoff and pre-reconnect upsert.
 */

import { EventEmitter } from "node:events";
import type {
  HelloPayload,
  PoolSnapshotPayload,
  AgentJoinedPayload,
  AgentUpdatedPayload,
  AgentStalePayload,
  AgentLeftPayload,
  InboundPromptPayload,
  ResponsePayload,
  MessageStatusPayload,
  ErrorPayload,
  RegisterResponse,
} from "../protocol/types.ts";
import { redactToken } from "../protocol/errors.ts";

export type SseConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed";

export interface SseClientConfig {
  baseUrl: string;
  authToken?: string;
  project?: string;
  sessionId: string;
  reconnectBaseMs?: number; // default: 500
  reconnectMaxMs?: number;  // default: 10_000
  fetchFn?: typeof fetch;   // for testing / dependency injection
  registerFn?: () => Promise<RegisterResponse>; // callback to re-register agent before reconnect
}

// ━━ Pure Chunk Parser ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class SseParser {
  private decoder = new TextDecoder("utf-8");
  private buffer = "";
  private readonly onEvent: (event: string, data: unknown, id?: string) => void;
  private readonly onComment?: (comment: string) => void;

  constructor(
    onEvent: (event: string, data: unknown, id?: string) => void,
    onComment?: (comment: string) => void
  ) {
    this.onEvent = onEvent;
    this.onComment = onComment;
  }

  public feed(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.processBuffer();
  }

  public flush(): void {
    this.buffer += this.decoder.decode();
    this.processBuffer();
  }

  public reset(): void {
    this.buffer = "";
    this.decoder = new TextDecoder("utf-8");
  }

  private processBuffer(): void {
    while (true) {
      const crlfIdx = this.buffer.indexOf("\r\n\r\n");
      const lfIdx = this.buffer.indexOf("\n\n");

      if (crlfIdx === -1 && lfIdx === -1) {
        break;
      }

      if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx <= lfIdx)) {
        const frameText = this.buffer.slice(0, crlfIdx);
        this.buffer = this.buffer.slice(crlfIdx + 4);
        this.parseFrame(frameText);
      } else if (lfIdx !== -1) {
        const frameText = this.buffer.slice(0, lfIdx);
        this.buffer = this.buffer.slice(lfIdx + 2);
        this.parseFrame(frameText);
      }
    }
  }

  private parseFrame(frame: string): void {
    let event = "message";
    const dataLines: string[] = [];
    let id: string | undefined;

    const lines = frame.split("\n");
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.length === 0) continue;

      if (line.startsWith(":")) {
        // SSE comment
        const comment = line.slice(1).trim();
        this.onComment?.(comment);
        continue;
      }

      if (line.startsWith("event:")) {
        event = line.slice(6).trimStart();
      } else if (line.startsWith("data:")) {
        let v = line.slice(5);
        if (v.startsWith(" ")) v = v.slice(1);
        dataLines.push(v);
      } else if (line.startsWith("id:")) {
        id = line.slice(3).trimStart();
      }
    }

    if (dataLines.length > 0) {
      const joined = dataLines.join("\n");
      let parsed: unknown = joined;
      try {
        parsed = JSON.parse(joined);
      } catch {
        // Preserve raw string if not JSON
      }
      this.onEvent(event, parsed, id);
    }
  }
}

// ━━ SSE Event Listener ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class SseEventListener extends EventEmitter {
  private state: SseConnectionState = "disconnected";
  private reconnectAttempts = 0;
  private notifiedReconnectCap = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private activeAbortController: AbortController | null = null;
  private activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private isShuttingDown = false;
  private lastPingAt: number | null = null;

  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly project: string;
  private readonly sessionId: string;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly registerFn?: () => Promise<RegisterResponse>;

  constructor(config: SseClientConfig) {
    super();
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.authToken = config.authToken || "";
    this.project = config.project || "default";
    this.sessionId = config.sessionId;
    this.reconnectBaseMs = config.reconnectBaseMs ?? 500;
    this.reconnectMaxMs = config.reconnectMaxMs ?? 10_000;
    this.fetchFn = config.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.registerFn = config.registerFn;
  }

  public getState(): SseConnectionState {
    return this.state;
  }

  public getLastPingAt(): number | null {
    return this.lastPingAt;
  }

  public getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  public async start(): Promise<void> {
    if (this.state === "connected" || this.state === "connecting") return;
    this.isShuttingDown = false;
    await this.connect();
  }

  public async stop(): Promise<void> {
    this.isShuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.activeAbortController) {
      try {
        this.activeAbortController.abort();
      } catch {
        // Ignore abort errors
      }
      this.activeAbortController = null;
    }
    if (this.activeReader) {
      const r = this.activeReader;
      this.activeReader = null;
      try {
        await r.cancel().catch(() => {});
      } catch {
        // Ignore cancel errors
      }
    }
    this.transitionState("closed");
  }

  private transitionState(next: SseConnectionState): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.emit("state_change", next, prev);
  }

  private async connect(): Promise<void> {
    if (this.isShuttingDown) return;
    this.transitionState("connecting");

    const qs = new URLSearchParams({
      project: this.project,
      session_id: this.sessionId,
    });
    const url = `${this.baseUrl}/v1/events?${qs.toString()}`;

    const headers: Record<string, string> = {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    };
    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }

    const ac = new AbortController();
    this.activeAbortController = ac;

    let resp: Response;
    try {
      resp = await this.fetchFn(url, {
        method: "GET",
        headers,
        signal: ac.signal,
      });
    } catch (err) {
      if (ac.signal.aborted || this.isShuttingDown) {
        this.transitionState("closed");
        return;
      }
      this.handleStreamFailure("connect_failed", err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (!resp.ok || !resp.body) {
      if (resp.status === 401) {
        const authErr = new Error("SSE 401 Unauthorized");
        this.emit("auth_failed", authErr);
        this.emit("error", authErr);
        this.transitionState("closed");
        return;
      }

      const err = new Error(`SSE connect failed: HTTP ${resp.status}`);
      if (resp.status === 404 && this.registerFn) {
        this.handleStreamFailure("agent_not_found", err);
      } else {
        this.handleStreamFailure("http_error", err);
      }
      return;
    }

    // Connected successfully
    this.reconnectAttempts = 0;
    this.notifiedReconnectCap = false;
    this.transitionState("connected");
    this.emit("connected");

    this.pumpStream(resp.body, ac).catch(() => {});
  }

  private async pumpStream(body: ReadableStream<Uint8Array>, ac: AbortController): Promise<void> {
    const parser = new SseParser(
      (event, data, id) => this.dispatchEvent(event, data, id),
      (comment) => this.handleComment(comment)
    );

    const reader = body.getReader();
    this.activeReader = reader;
    try {
      while (!this.isShuttingDown) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          parser.feed(value);
        }
      }
      parser.flush();
      if (!this.isShuttingDown) {
        this.handleStreamFailure("stream_end");
      }
    } catch (err: unknown) {
      const isAbort =
        (err as { name?: string })?.name === "AbortError" ||
        ac.signal.aborted ||
        this.isShuttingDown;
      if (isAbort) {
        this.transitionState("closed");
        return;
      }
      this.handleStreamFailure("stream_error", err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.activeReader = null;
      try {
        reader.releaseLock();
      } catch {
        // Reader release best effort
      }
    }
  }

  private handleComment(comment: string): void {
    if (comment.startsWith("ping")) {
      const ts = comment.slice(4).trim();
      this.lastPingAt = Date.now();
      this.emit("ping", ts);
    }
  }

  private dispatchEvent(event: string, data: unknown, id?: string): void {
    // Typed event emission
    this.emit(event, data, id);
  }

  private handleStreamFailure(reason: string, error?: Error): void {
    if (this.isShuttingDown) {
      this.transitionState("closed");
      return;
    }

    const safeMessage = error ? redactToken(error.message) : undefined;
    const safeError = error ? new Error(safeMessage) : undefined;

    this.emit("disconnected", reason, safeError);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.isShuttingDown || this.reconnectTimer) return;
    this.transitionState("reconnecting");

    const delayMs = Math.min(
      this.reconnectBaseMs * Math.pow(2, this.reconnectAttempts),
      this.reconnectMaxMs
    );
    this.reconnectAttempts++;

    this.emit("reconnect_scheduled", this.reconnectAttempts, delayMs);

    if (delayMs >= this.reconnectMaxMs && !this.notifiedReconnectCap) {
      this.notifiedReconnectCap = true;
      this.emit("reconnect_cap_reached");
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.isShuttingDown) return;

      try {
        // Step 1: Re-register with the hub before opening stream
        if (this.registerFn) {
          await this.registerFn();
        }
        // Step 2: Open SSE stream
        await this.connect();
      } catch (err) {
        this.handleStreamFailure("re_register_failed", err instanceof Error ? err : new Error(String(err)));
      }
    }, delayMs);

    try {
      this.reconnectTimer.unref?.();
    } catch {
      // Ignore unref error
    }
  }
}
