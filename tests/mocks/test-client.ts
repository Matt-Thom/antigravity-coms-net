/**
 * TestClient: High-fidelity, opaque-box client harness for exercising coms-net protocol.
 */

import http from "node:http";
import { EventEmitter } from "node:events";
import type { AgentCard, ComsMessage } from "./mock-hub.ts";

export interface SseEvent {
  event: string;
  id?: number;
  data: any;
  raw: string;
}

export class TestClient {
  public baseUrl: string;
  public token: string;
  public project: string;

  constructor(baseUrl: string, token: string, project: string = "default") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.project = project;
  }

  public async request<T = any>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      timeout?: number;
      tokenOverride?: string | null;
    } = {}
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: T }> {
    const url = new URL(path, this.baseUrl);
    const method = options.method ?? "GET";
    const headers: Record<string, string> = {
      ...(options.headers ?? {}),
    };

    if (options.tokenOverride !== null) {
      const token = options.tokenOverride !== undefined ? options.tokenOverride : this.token;
      if (token && !headers["authorization"]) {
        headers["authorization"] = `Bearer ${token}`;
      }
    }

    let payload: string | undefined;
    if (options.body !== undefined) {
      payload = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      if (!headers["content-type"]) {
        headers["content-type"] = "application/json";
      }
    }

    return new Promise((resolve, reject) => {
      const req = http.request(url, { method, headers, timeout: options.timeout ?? 10000 }, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let parsed: any = data;
          const ct = res.headers["content-type"] ?? "";
          if (ct.includes("application/json") && data.length > 0) {
            try {
              parsed = JSON.parse(data);
            } catch {
              // keep as string
            }
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: parsed,
          });
        });
      });

      req.on("error", reject);
      if (options.timeout) {
        req.on("timeout", () => {
          req.destroy(new Error("Request timed out"));
        });
      }

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  public async getHealth(): Promise<{ status: number; body: any }> {
    return this.request("/health", { tokenOverride: null });
  }

  public async register(params: {
    session_id: string;
    name: string;
    purpose?: string;
    model?: string;
    provider?: string;
    color?: string;
    cwd?: string;
    explicit?: boolean;
    project?: string;
  }): Promise<{ status: number; body: any }> {
    return this.request("/v1/agents/register", {
      method: "POST",
      body: {
        project: params.project ?? this.project,
        ...params,
      },
    });
  }

  public async heartbeat(
    sessionId: string,
    metrics?: {
      context_used_pct?: number;
      queue_depth?: number;
      model?: string;
      status?: "online" | "stale" | "offline";
      project?: string;
    }
  ): Promise<{ status: number; body: any }> {
    return this.request(`/v1/agents/${encodeURIComponent(sessionId)}/heartbeat`, {
      method: "POST",
      body: {
        project: metrics?.project ?? this.project,
        ...metrics,
      },
    });
  }

  public async listAgents(options: { project?: string; include_explicit?: boolean } = {}): Promise<{
    status: number;
    body: { agents: AgentCard[] };
  }> {
    const q = new URLSearchParams();
    q.set("project", options.project ?? this.project);
    if (options.include_explicit) {
      q.set("include_explicit", "true");
    }
    return this.request(`/v1/agents?${q.toString()}`);
  }

  public async sendMessage(params: {
    sender_session: string;
    target?: string;
    target_session?: string;
    prompt: string;
    conversation_id?: string;
    response_schema?: Record<string, unknown>;
    hops?: number;
    project?: string;
  }): Promise<{ status: number; body: any }> {
    return this.request("/v1/messages", {
      method: "POST",
      body: {
        project: params.project ?? this.project,
        ...params,
      },
    });
  }

  public async getMessage(msgId: string): Promise<{ status: number; body: any }> {
    return this.request(`/v1/messages/${encodeURIComponent(msgId)}`);
  }

  public async awaitMessage(
    msgId: string,
    timeoutMs?: number
  ): Promise<{ status: number; body: any }> {
    const q = timeoutMs ? `?timeout_ms=${timeoutMs}` : "";
    return this.request(`/v1/messages/${encodeURIComponent(msgId)}/await${q}`, {
      timeout: (timeoutMs ?? 30000) + 5000,
    });
  }

  public async submitResponse(
    msgId: string,
    params: {
      responder_session: string;
      response?: unknown;
      error?: string | null;
      project?: string;
    }
  ): Promise<{ status: number; body: any }> {
    return this.request(`/v1/messages/${encodeURIComponent(msgId)}/response`, {
      method: "POST",
      body: {
        project: params.project ?? this.project,
        ...params,
      },
    });
  }

  public async unregister(sessionId: string, project?: string): Promise<{ status: number; body: any }> {
    const p = project ?? this.project;
    return this.request(`/v1/agents/${encodeURIComponent(sessionId)}?project=${encodeURIComponent(p)}`, {
      method: "DELETE",
    });
  }

  public connectSse(sessionId: string, project?: string): SseSubscription {
    const p = project ?? this.project;
    const url = new URL(`/v1/events?project=${encodeURIComponent(p)}&session_id=${encodeURIComponent(sessionId)}`, this.baseUrl);
    return new SseSubscription(url, this.token);
  }
}

export class SseSubscription extends EventEmitter {
  private req: http.ClientRequest | null = null;
  private url: URL;
  private token: string;
  public events: SseEvent[] = [];
  public keepalives: string[] = [];
  public closed: boolean = false;
  private consumedEventIndex: number = 0;

  constructor(url: URL, token: string) {
    super();
    this.url = url;
    this.token = token;
    this.connect();
  }

  private connect(): void {
    this.req = http.request(
      this.url,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "text/event-stream",
        },
      },
      (res) => {
        let buffer = "";
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf-8");
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            if (!part.trim()) continue;
            this.parseBlock(part);
          }
        });

        res.on("end", () => {
          this.closed = true;
          this.emit("end");
        });
      }
    );

    this.req.on("error", (err) => {
      this.emit("error", err);
    });

    this.req.end();
  }

  private parseBlock(block: string): void {
    const lines = block.split("\n");
    let eventName = "message";
    let id: number | undefined;
    let dataStr = "";

    for (const line of lines) {
      if (line.startsWith(": ping")) {
        this.keepalives.push(line.slice(2).trim());
        this.emit("ping", line.slice(2).trim());
        return;
      }
      if (line.startsWith("event: ")) {
        eventName = line.slice(7).trim();
      } else if (line.startsWith("id: ")) {
        id = Number(line.slice(4).trim());
      } else if (line.startsWith("data: ")) {
        dataStr = line.slice(6).trim();
      }
    }

    let parsedData: any = dataStr;
    try {
      parsedData = JSON.parse(dataStr);
    } catch {
      // keep raw string
    }

    const sseEvent: SseEvent = { event: eventName, id, data: parsedData, raw: block };
    this.events.push(sseEvent);
    this.emit("event", sseEvent);
    this.emit(eventName, parsedData);
  }

  public async waitForEvent(eventName: string, timeoutMs: number = 5000): Promise<any> {
    for (let i = this.consumedEventIndex; i < this.events.length; i++) {
      if (this.events[i].event === eventName) {
        this.consumedEventIndex = i + 1;
        return this.events[i].data;
      }
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(eventName, onEvent);
        reject(new Error(`Timeout waiting for SSE event '${eventName}' after ${timeoutMs}ms`));
      }, timeoutMs);

      const onEvent = (data: any) => {
        clearTimeout(timer);
        this.consumedEventIndex = this.events.length;
        resolve(data);
      };

      this.once(eventName, onEvent);
    });
  }

  public close(): void {
    this.closed = true;
    if (this.req) {
      this.req.destroy();
      this.req = null;
    }
  }
}
