/**
 * In-process Mock coms-net Hub Server strictly adhering to protocol_spec.md
 * Provides 100% protocol-compliant REST endpoints and SSE streaming for testing.
 */

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Crockford Base32 alphabet for ULID generation
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateUlid(time: number = Date.now()): string {
  let str = "";
  let t = time;
  for (let i = 9; i >= 0; i--) {
    const mod = t % 32;
    str = ENCODING[mod] + str;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 16; i++) {
    const b = bytes[i % 10];
    str += ENCODING[b % 32];
  }
  return str;
}

export function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf-8");
  const bb = Buffer.from(b, "utf-8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function sseFrame(event: string, data: unknown, id?: number): string {
  const lines = [`event: ${event}`];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return lines.join("\n") + "\n\n";
}

export interface AgentCard {
  session_id: string;
  name: string;
  purpose: string;
  model: string;
  provider?: string;
  color: string;
  cwd: string;
  project: string;
  explicit: boolean;
  started_at: string;
  context_used_pct: number;
  queue_depth: number;
  status: "online" | "stale" | "offline";
}

export interface RegistryEntry extends AgentCard {
  registered_at: string;
  last_seen_at: string;
}

export interface ComsMessage {
  msg_id: string;
  project: string;
  sender_session: string;
  target_session: string;
  prompt: string;
  conversation_id: string | null;
  response_schema: Record<string, unknown> | null;
  hops: number;
  status: "queued" | "delivered" | "complete" | "error" | "timeout";
  response: unknown | null;
  error: string | null;
  created_at: string;
  expires_at: string;
  delivered_at?: string;
  completed_at?: string;
}

export interface SseClient {
  sessionId: string;
  res: http.ServerResponse;
  lastId: number;
}

export interface Awaiter {
  resolve: (msg: ComsMessage) => void;
  timer: NodeJS.Timeout | null;
}

export interface ProjectState {
  name: string;
  agents: Map<string, RegistryEntry>;
  nameIndex: Map<string, Set<string>>;
  messages: Map<string, ComsMessage>;
  streams: Map<string, SseClient>;
  awaiters: Map<string, Set<Awaiter>>;
}

export interface MockHubOptions {
  port?: number;
  host?: string;
  token?: string;
  maxHops?: number;
  maxInbox?: number;
  heartbeatMs?: number;
  staleAfterMs?: number;
  offlineAfterMs?: number;
  messageTtlMs?: number;
}

export class MockHub {
  public readonly serverId: string;
  public readonly startedAt: string;
  public readonly host: string;
  public readonly portRequested: number;
  public readonly token: string;
  public readonly maxHops: number;
  public readonly maxInbox: number;
  public readonly heartbeatMs: number;
  public readonly staleAfterMs: number;
  public readonly offlineAfterMs: number;
  public readonly messageTtlMs: number;

  private server: http.Server | null = null;
  private actualPort: number = 0;
  private projects = new Map<string, ProjectState>();
  private createdFiles: string[] = [];

  constructor(options: MockHubOptions = {}) {
    this.serverId = generateUlid();
    this.startedAt = new Date().toISOString();
    this.host = options.host ?? "127.0.0.1";
    this.portRequested = options.port ?? 0;
    this.token = options.token ?? crypto.randomBytes(32).toString("hex");
    this.maxHops = options.maxHops ?? 5;
    this.maxInbox = options.maxInbox ?? 100;
    this.heartbeatMs = options.heartbeatMs ?? 10000;
    this.staleAfterMs = options.staleAfterMs ?? 30000;
    this.offlineAfterMs = options.offlineAfterMs ?? 60000;
    this.messageTtlMs = options.messageTtlMs ?? 1800000;
  }

  public get baseUrl(): string {
    return `http://${this.host}:${this.actualPort}`;
  }

  public get localUrl(): string {
    return this.baseUrl;
  }

  public get port(): number {
    return this.actualPort;
  }

  public getProject(name: string = "default"): ProjectState {
    let p = this.projects.get(name);
    if (!p) {
      p = {
        name,
        agents: new Map(),
        nameIndex: new Map(),
        messages: new Map(),
        streams: new Map(),
        awaiters: new Map(),
      };
      this.projects.set(name, p);
    }
    return p;
  }

  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "internal_server_error", message: String(err) }));
        });
      });

      this.server.on("error", reject);

      this.server.listen(this.portRequested, this.host, () => {
        const addr = this.server?.address();
        if (addr && typeof addr === "object") {
          this.actualPort = addr.port;
        }
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    // Close all SSE streams with shutdown event
    for (const p of this.projects.values()) {
      for (const client of p.streams.values()) {
        try {
          client.res.write(sseFrame("agent_left", {
            project: p.name,
            session_id: client.sessionId,
            name: p.agents.get(client.sessionId)?.name ?? "unknown",
            reason: "shutdown",
          }));
          client.res.end();
        } catch {
          // ignore
        }
      }
      p.streams.clear();

      // Clear any pending awaiters
      for (const [msgId, set] of p.awaiters.entries()) {
        for (const awaiter of set) {
          if (awaiter.timer) clearTimeout(awaiter.timer);
        }
      }
      p.awaiters.clear();
    }

    // Unlink any registered discovery files
    for (const file of this.createdFiles) {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      } catch {
        // ignore
      }
    }
    this.createdFiles = [];

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Writes standard server.json and 0600 server.secret.json for discovery tests.
   */
  public writeDiscoveryFiles(dirPath?: string, projectName: string = "default"): { serverJsonPath: string; secretJsonPath: string } {
    const targetDir = dirPath ?? path.join(os.homedir(), ".pi", "coms-net", "projects", projectName);
    fs.mkdirSync(targetDir, { recursive: true });

    const serverJsonPath = path.join(targetDir, "server.json");
    const secretJsonPath = path.join(targetDir, "server.secret.json");

    const serverMeta = {
      version: 1,
      project: projectName,
      pid: process.pid,
      host: this.host,
      port: this.actualPort,
      local_url: this.baseUrl,
      public_url: this.baseUrl,
      started_at: this.startedAt,
      server_id: this.serverId,
    };

    fs.writeFileSync(serverJsonPath, JSON.stringify(serverMeta, null, 2), { mode: 0o644 });
    this.createdFiles.push(serverJsonPath);

    fs.writeFileSync(secretJsonPath, JSON.stringify({ token: this.token }, null, 2), { mode: 0o600 });
    fs.chmodSync(secretJsonPath, 0o600);
    this.createdFiles.push(secretJsonPath);

    return { serverJsonPath, secretJsonPath };
  }

  /**
   * Manually trigger dead peer check (30s stale, 60s offline)
   */
  public triggerStaleScan(nowMs: number = Date.now(), projectName?: string): { staled: string[]; purged: string[] } {
    const targetProjects = projectName ? [this.getProject(projectName)] : [...this.projects.values()];
    const staled: string[] = [];
    const purged: string[] = [];

    for (const p of targetProjects) {
      for (const [sid, agent] of [...p.agents.entries()]) {
        const lastSeen = new Date(agent.last_seen_at).getTime();
        const elapsed = nowMs - lastSeen;

        if (elapsed > this.offlineAfterMs) {
          // Purge offline agent
          p.agents.delete(sid);
          this.nameIndexRemove(p, agent.name, sid);
          const stream = p.streams.get(sid);
          if (stream) {
            try { stream.res.end(); } catch {}
            p.streams.delete(sid);
          }
          this.broadcast(p, "agent_left", {
            project: p.name,
            session_id: sid,
            name: agent.name,
            reason: "stale",
          }, sid);
          purged.push(sid);
        } else if (elapsed > this.staleAfterMs && agent.status !== "stale") {
          agent.status = "stale";
          this.broadcast(p, "agent_stale", {
            project: p.name,
            session_id: sid,
            name: agent.name,
            last_seen_at: agent.last_seen_at,
          }, sid);
          staled.push(sid);
        }
      }
    }

    return { staled, purged };
  }

  /**
   * Manually trigger message TTL purge
   */
  public triggerTtlScan(nowMs: number = Date.now(), projectName?: string): string[] {
    const targetProjects = projectName ? [this.getProject(projectName)] : [...this.projects.values()];
    const expiredIds: string[] = [];
    for (const p of targetProjects) {
      for (const [msgId, msg] of [...p.messages.entries()]) {
        const expiresAt = new Date(msg.expires_at).getTime();
        if (nowMs > expiresAt && (msg.status === "queued" || msg.status === "delivered")) {
          msg.status = "error";
          msg.error = "expired";
          this.releaseAwaiters(p, msgId);
          p.messages.delete(msgId);
          expiredIds.push(msgId);
        }
      }
    }
    return expiredIds;
  }

  /**
   * Broadcast an SSE keepalive ping to all active SSE streams
   */
  public emitKeepalive(): void {
    const pingComment = `: ping ${new Date().toISOString()}\n\n`;
    for (const p of this.projects.values()) {
      for (const client of p.streams.values()) {
        try {
          client.res.write(pingComment);
        } catch {
          // ignore
        }
      }
    }
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const authHeader = req.headers["authorization"] ?? "";
    if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
      return false;
    }
    const reqToken = authHeader.slice(7).trim();
    return tokensEqual(reqToken, this.token);
  }

  private sendUnauthorized(res: http.ServerResponse): void {
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="coms-net"',
    });
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private sendError(res: http.ServerResponse, status: number, error: string, details?: unknown): void {
    const payload: { ok: boolean; error: string; details?: unknown } = { ok: false, error };
    if (details !== undefined) payload.details = details;
    this.sendJson(res, status, payload);
  }

  private async readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => {
        data += chunk;
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }

  private nameIndexAdd(p: ProjectState, name: string, sessionId: string): void {
    let bag = p.nameIndex.get(name);
    if (!bag) {
      bag = new Set();
      p.nameIndex.set(name, bag);
    }
    bag.add(sessionId);
  }

  private nameIndexRemove(p: ProjectState, name: string, sessionId: string): void {
    const bag = p.nameIndex.get(name);
    if (bag) {
      bag.delete(sessionId);
      if (bag.size === 0) p.nameIndex.delete(name);
    }
  }

  private resolveUniqueName(p: ProjectState, desired: string): string {
    const liveNames = new Set([...p.agents.values()].map((a) => a.name));
    if (!liveNames.has(desired)) return desired;
    let n = 2;
    while (liveNames.has(`${desired}${n}`)) n++;
    return `${desired}${n}`;
  }

  private broadcast(p: ProjectState, event: string, data: unknown, excludeSessionId?: string): void {
    for (const [sid, client] of p.streams.entries()) {
      if (excludeSessionId && sid === excludeSessionId) continue;
      const id = ++client.lastId;
      try {
        client.res.write(sseFrame(event, data, id));
      } catch {
        // Stream disconnected
      }
    }
  }

  private sendToStream(p: ProjectState, sessionId: string, event: string, data: unknown): void {
    const client = p.streams.get(sessionId);
    if (client) {
      const id = ++client.lastId;
      try {
        client.res.write(sseFrame(event, data, id));
      } catch {
        // Stream write failed
      }
    }
  }

  private releaseAwaiters(p: ProjectState, msgId: string): void {
    const set = p.awaiters.get(msgId);
    if (!set || set.size === 0) return;
    const msg = p.messages.get(msgId);
    if (!msg) return;

    for (const awaiter of set) {
      if (awaiter.timer) clearTimeout(awaiter.timer);
      try {
        awaiter.resolve(msg);
      } catch {
        // ignore
      }
    }
    p.awaiters.delete(msgId);
  }

  private inboxDepthFor(p: ProjectState, targetSessionId: string): number {
    let count = 0;
    for (const m of p.messages.values()) {
      if (m.target_session === targetSessionId && (m.status === "queued" || m.status === "delivered")) {
        count++;
      }
    }
    return count;
  }

  private entryToCard(entry: RegistryEntry): AgentCard {
    return {
      session_id: entry.session_id,
      name: entry.name,
      purpose: entry.purpose,
      model: entry.model,
      provider: entry.provider,
      color: entry.color,
      cwd: entry.cwd,
      project: entry.project,
      explicit: entry.explicit,
      started_at: entry.started_at,
      context_used_pct: entry.context_used_pct,
      queue_depth: entry.queue_depth,
      status: entry.status,
    };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const rawUrl = req.url ?? "/";
    const parsedUrl = new URL(rawUrl, this.baseUrl);
    const pathname = parsedUrl.pathname;
    const method = (req.method ?? "GET").toUpperCase();

    // 1. GET /health (unauthenticated)
    if (method === "GET" && pathname === "/health") {
      this.sendJson(res, 200, {
        ok: true,
        version: 1,
        server_id: this.serverId,
        started_at: this.startedAt,
      });
      return;
    }

    // All /v1/* routes require Bearer token authentication
    if (!this.isAuthorized(req)) {
      this.sendUnauthorized(res);
      return;
    }

    // 2. POST /v1/agents/register
    if (method === "POST" && pathname === "/v1/agents/register") {
      const bodyRaw = await this.readBody(req);
      let body: any;
      try {
        body = JSON.parse(bodyRaw);
      } catch {
        this.sendError(res, 400, "invalid_json");
        return;
      }

      if (!body || typeof body !== "object" || !body.session_id || !body.name) {
        this.sendError(res, 400, "invalid_request");
        return;
      }

      const projectName = body.project || "default";
      const p = this.getProject(projectName);
      const desiredName = String(body.name).trim() || "agent";
      const existing = p.agents.get(body.session_id);

      let resolvedName = desiredName;
      if (existing) {
        resolvedName = body.name && body.name !== existing.name
          ? this.resolveUniqueName(p, desiredName)
          : existing.name;
      } else {
        resolvedName = this.resolveUniqueName(p, desiredName);
      }

      const card: AgentCard = {
        session_id: body.session_id,
        name: resolvedName,
        purpose: body.purpose ?? "",
        model: body.model ?? "unknown",
        provider: body.provider,
        color: body.color ?? "#888888",
        cwd: body.cwd ?? "",
        project: projectName,
        explicit: body.explicit === true,
        started_at: existing?.started_at ?? new Date().toISOString(),
        context_used_pct: existing?.context_used_pct ?? 0,
        queue_depth: existing?.queue_depth ?? 0,
        status: "online",
      };

      const entry: RegistryEntry = {
        ...card,
        registered_at: existing?.registered_at ?? new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      };

      if (existing && existing.name !== entry.name) {
        this.nameIndexRemove(p, existing.name, body.session_id);
      }
      p.agents.set(body.session_id, entry);
      this.nameIndexAdd(p, entry.name, body.session_id);

      // Broadcast agent_joined to other streams
      this.broadcast(p, "agent_joined", { project: projectName, agent: this.entryToCard(entry) }, body.session_id);

      this.sendJson(res, 200, {
        ok: true,
        agent: this.entryToCard(entry),
        heartbeat_interval_ms: this.heartbeatMs,
        sse_url: `/v1/events?project=${encodeURIComponent(projectName)}&session_id=${encodeURIComponent(body.session_id)}`,
      });
      return;
    }

    // 3. POST /v1/agents/:session_id/heartbeat
    const heartbeatMatch = pathname.match(/^\/v1\/agents\/([^/]+)\/heartbeat$/);
    if (method === "POST" && heartbeatMatch) {
      const sid = decodeURIComponent(heartbeatMatch[1]);
      const bodyRaw = await this.readBody(req);
      let body: any = {};
      if (bodyRaw.trim().length > 0) {
        try {
          body = JSON.parse(bodyRaw);
        } catch {
          this.sendError(res, 400, "invalid_json");
          return;
        }
      }

      const projectName = body.project || "default";
      const p = this.getProject(projectName);
      const agent = p.agents.get(sid);
      if (!agent) {
        this.sendError(res, 404, "agent_not_found");
        return;
      }

      agent.last_seen_at = new Date().toISOString();
      let changed = false;

      if (typeof body.context_used_pct === "number" && body.context_used_pct !== agent.context_used_pct) {
        agent.context_used_pct = body.context_used_pct;
        changed = true;
      }
      if (typeof body.queue_depth === "number" && body.queue_depth !== agent.queue_depth) {
        agent.queue_depth = body.queue_depth;
        changed = true;
      }
      if (typeof body.model === "string" && body.model !== agent.model) {
        agent.model = body.model;
        changed = true;
      }
      if (typeof body.status === "string" && body.status !== agent.status) {
        agent.status = body.status;
        changed = true;
      }

      if (changed) {
        this.broadcast(p, "agent_updated", {
          project: projectName,
          agent: {
            session_id: agent.session_id,
            name: agent.name,
            context_used_pct: agent.context_used_pct,
            queue_depth: agent.queue_depth,
            model: agent.model,
            status: agent.status,
          },
        }, sid);
      }

      this.sendJson(res, 200, { ok: true });
      return;
    }

    // 4. GET /v1/agents
    if (method === "GET" && pathname === "/v1/agents") {
      const projectName = parsedUrl.searchParams.get("project") ?? "default";
      const includeExplicit = parsedUrl.searchParams.get("include_explicit") === "true";
      const p = this.getProject(projectName);

      const out: AgentCard[] = [];
      for (const a of p.agents.values()) {
        if (!includeExplicit && a.explicit) continue;
        out.push(this.entryToCard(a));
      }

      this.sendJson(res, 200, { agents: out });
      return;
    }

    // 5. POST /v1/messages
    if (method === "POST" && pathname === "/v1/messages") {
      const bodyRaw = await this.readBody(req);
      let body: any;
      try {
        body = JSON.parse(bodyRaw);
      } catch {
        this.sendError(res, 400, "invalid_json");
        return;
      }

      if (!body || typeof body !== "object" || !body.sender_session || typeof body.prompt !== "string") {
        this.sendError(res, 400, "invalid_request");
        return;
      }

      const projectName = body.project ?? "default";
      const p = this.getProject(projectName);

      const sender = p.agents.get(body.sender_session);
      if (!sender) {
        this.sendError(res, 404, "sender_not_registered");
        return;
      }

      const hops = typeof body.hops === "number" ? body.hops : 0;
      if (hops >= this.maxHops) {
        this.sendError(res, 409, "hop_limit_exceeded", { hops, max_hops: this.maxHops });
        return;
      }

      // Target resolution
      let target: RegistryEntry | undefined;
      if (body.target_session && typeof body.target_session === "string") {
        target = p.agents.get(body.target_session);
        if (!target) {
          this.sendError(res, 404, "target_not_found");
          return;
        }
      } else {
        const desired = (body.target ?? "").trim();
        if (!desired) {
          this.sendError(res, 400, "missing_target");
          return;
        }
        const directSid = p.agents.get(desired);
        if (directSid) {
          target = directSid;
        } else {
          const bag = p.nameIndex.get(desired);
          if (!bag || bag.size === 0) {
            this.sendError(res, 404, "target_not_found", { target: desired });
            return;
          }
          if (bag.size > 1) {
            this.sendError(res, 409, "ambiguous_target", { target: desired, candidates: [...bag] });
            return;
          }
          const onlySid = [...bag][0];
          target = p.agents.get(onlySid);
          if (!target) {
            this.sendError(res, 404, "target_not_found");
            return;
          }
        }
      }

      // Inbox depth check
      const depth = this.inboxDepthFor(p, target.session_id);
      if (depth >= this.maxInbox) {
        this.sendError(res, 429, "inbox_full", { depth, max_inbox: this.maxInbox });
        return;
      }

      const msgId = generateUlid();
      const now = new Date().toISOString();
      const expires = new Date(Date.now() + this.messageTtlMs).toISOString();

      const msg: ComsMessage = {
        msg_id: msgId,
        project: projectName,
        sender_session: body.sender_session,
        target_session: target.session_id,
        prompt: body.prompt,
        conversation_id: typeof body.conversation_id === "string" ? body.conversation_id : null,
        response_schema: typeof body.response_schema === "object" ? body.response_schema : null,
        hops,
        status: "queued",
        response: null,
        error: null,
        created_at: now,
        expires_at: expires,
      };

      p.messages.set(msgId, msg);

      // Notify sender: queued
      this.sendToStream(p, body.sender_session, "message_status", {
        msg_id: msgId,
        status: "queued",
      });

      // If target SSE stream is open, deliver immediately
      const targetStream = p.streams.get(target.session_id);
      if (targetStream) {
        this.sendToStream(p, target.session_id, "prompt", {
          msg_id: msgId,
          project: projectName,
          sender: {
            session_id: sender.session_id,
            name: sender.name,
            cwd: sender.cwd,
          },
          prompt: msg.prompt,
          conversation_id: msg.conversation_id,
          response_schema: msg.response_schema,
          hops: msg.hops,
        });
        msg.status = "delivered";
        msg.delivered_at = new Date().toISOString();

        // Notify sender: delivered
        this.sendToStream(p, body.sender_session, "message_status", {
          msg_id: msgId,
          status: "delivered",
        });
      }

      this.sendJson(res, 200, {
        ok: true,
        msg_id: msgId,
        status: msg.status,
        target_session: target.session_id,
      });
      return;
    }

    // 6. GET /v1/messages/:msg_id/await
    const awaitMatch = pathname.match(/^\/v1\/messages\/([^/]+)\/await$/);
    if (method === "GET" && awaitMatch) {
      const msgId = decodeURIComponent(awaitMatch[1]);
      let project: ProjectState | undefined;
      let msg: ComsMessage | undefined;

      for (const p of this.projects.values()) {
        const m = p.messages.get(msgId);
        if (m) {
          project = p;
          msg = m;
          break;
        }
      }

      if (!project || !msg) {
        this.sendError(res, 404, "message_not_found");
        return;
      }

      // If already terminal, return immediately
      if (msg.status === "complete" || msg.status === "error" || msg.status === "timeout") {
        this.sendJson(res, 200, {
          msg_id: msg.msg_id,
          status: msg.status,
          response: msg.response ?? null,
          error: msg.error ?? null,
        });
        return;
      }

      const requestedTimeout = Number(parsedUrl.searchParams.get("timeout_ms") ?? "");
      let timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 30000;
      if (timeoutMs > this.messageTtlMs) timeoutMs = this.messageTtlMs;

      let resolved = false;
      const set = project.awaiters.get(msgId) ?? new Set<Awaiter>();
      project.awaiters.set(msgId, set);

      const awaiter: Awaiter = {
        resolve: (m: ComsMessage) => {
          if (resolved) return;
          resolved = true;
          this.sendJson(res, 200, {
            msg_id: m.msg_id,
            status: m.status,
            response: m.response ?? null,
            error: m.error ?? null,
          });
        },
        timer: null,
      };

      awaiter.timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        const cur = project?.awaiters.get(msgId);
        if (cur) {
          cur.delete(awaiter);
          if (cur.size === 0) project?.awaiters.delete(msgId);
        }
        this.sendJson(res, 200, {
          msg_id: msgId,
          status: "timeout",
          response: null,
          error: "timeout",
        });
      }, timeoutMs);

      set.add(awaiter);

      req.on("close", () => {
        if (!resolved) {
          resolved = true;
          if (awaiter.timer) clearTimeout(awaiter.timer);
          const cur = project?.awaiters.get(msgId);
          if (cur) {
            cur.delete(awaiter);
            if (cur.size === 0) project?.awaiters.delete(msgId);
          }
        }
      });

      return;
    }

    // 7. GET /v1/messages/:msg_id
    const getMsgMatch = pathname.match(/^\/v1\/messages\/([^/]+)$/);
    if (method === "GET" && getMsgMatch) {
      const msgId = decodeURIComponent(getMsgMatch[1]);
      for (const p of this.projects.values()) {
        const m = p.messages.get(msgId);
        if (m) {
          this.sendJson(res, 200, {
            msg_id: m.msg_id,
            status: m.status,
            response: m.response ?? null,
            error: m.error ?? null,
          });
          return;
        }
      }
      this.sendError(res, 404, "message_not_found");
      return;
    }

    // 8. POST /v1/messages/:msg_id/response
    const respMatch = pathname.match(/^\/v1\/messages\/([^/]+)\/response$/);
    if (method === "POST" && respMatch) {
      const msgId = decodeURIComponent(respMatch[1]);
      const bodyRaw = await this.readBody(req);
      let body: any;
      try {
        body = JSON.parse(bodyRaw);
      } catch {
        this.sendError(res, 400, "invalid_json");
        return;
      }

      if (!body || typeof body !== "object" || typeof body.responder_session !== "string") {
        this.sendError(res, 400, "invalid_request");
        return;
      }

      let project: ProjectState | undefined;
      let msg: ComsMessage | undefined;
      for (const p of this.projects.values()) {
        const m = p.messages.get(msgId);
        if (m) {
          project = p;
          msg = m;
          break;
        }
      }

      if (!project || !msg) {
        this.sendError(res, 404, "message_not_found");
        return;
      }

      if (body.responder_session !== msg.target_session) {
        this.sendError(res, 403, "not_target");
        return;
      }

      if (msg.status === "complete" || msg.status === "error" || msg.status === "timeout") {
        this.sendError(res, 409, "already_terminal", { status: msg.status });
        return;
      }

      const isError = body.error !== null && body.error !== undefined;
      msg.status = isError ? "error" : "complete";
      msg.response = body.response ?? null;
      msg.error = isError ? String(body.error) : null;
      msg.completed_at = new Date().toISOString();

      const responder = project.agents.get(body.responder_session);
      const responderName = responder?.name ?? "unknown";

      // Push SSE response to sender
      this.sendToStream(project, msg.sender_session, "response", {
        msg_id: msg.msg_id,
        project: msg.project,
        responder: { session_id: body.responder_session, name: responderName },
        response: msg.response,
        error: msg.error,
        status: msg.status,
      });

      // Push SSE message_status to sender
      this.sendToStream(project, msg.sender_session, "message_status", {
        msg_id: msg.msg_id,
        status: msg.status,
      });

      // Release HTTP awaiters
      this.releaseAwaiters(project, msgId);

      this.sendJson(res, 200, { ok: true });
      return;
    }

    // 9. DELETE /v1/agents/:session_id
    const deleteAgentMatch = pathname.match(/^\/v1\/agents\/([^/]+)$/);
    if (method === "DELETE" && deleteAgentMatch) {
      const sid = decodeURIComponent(deleteAgentMatch[1]);
      const projectName = parsedUrl.searchParams.get("project") ?? "default";
      const p = this.getProject(projectName);

      const entry = p.agents.get(sid);
      if (!entry) {
        this.sendError(res, 404, "agent_not_found");
        return;
      }

      const stream = p.streams.get(sid);
      if (stream) {
        try { stream.res.end(); } catch {}
        p.streams.delete(sid);
      }

      p.agents.delete(sid);
      this.nameIndexRemove(p, entry.name, sid);

      this.broadcast(p, "agent_left", {
        project: projectName,
        session_id: sid,
        name: entry.name,
        reason: "shutdown",
      }, sid);

      this.sendJson(res, 200, { ok: true });
      return;
    }

    // 10. GET /v1/events (SSE Stream)
    if (method === "GET" && pathname === "/v1/events") {
      const projectName = parsedUrl.searchParams.get("project") ?? "default";
      const sessionId = parsedUrl.searchParams.get("session_id") ?? "";

      if (!sessionId) {
        this.sendError(res, 400, "missing_session_id");
        return;
      }

      const p = this.getProject(projectName);
      const entry = p.agents.get(sessionId);
      if (!entry) {
        this.sendError(res, 404, "agent_not_found");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });

      // Close old stream if present
      const oldClient = p.streams.get(sessionId);
      if (oldClient && oldClient.res !== res) {
        try { oldClient.res.end(); } catch {}
      }

      const client: SseClient = {
        sessionId,
        res,
        lastId: 0,
      };
      p.streams.set(sessionId, client);

      // Send initial hello
      res.write(sseFrame("hello", {
        server_time: new Date().toISOString(),
        server_id: this.serverId,
      }, ++client.lastId));

      // Send initial pool_snapshot
      const agents: AgentCard[] = [];
      for (const a of p.agents.values()) {
        if (a.session_id === sessionId) continue;
        if (a.explicit) continue;
        agents.push(this.entryToCard(a));
      }
      res.write(sseFrame("pool_snapshot", {
        project: projectName,
        agents,
      }, ++client.lastId));

      req.on("close", () => {
        const cur = p.streams.get(sessionId);
        if (cur && cur.res === res) {
          p.streams.delete(sessionId);
          this.broadcast(p, "agent_left", {
            project: projectName,
            session_id: sessionId,
            name: entry.name,
            reason: "connection_closed",
          }, sessionId);
        }
      });

      return;
    }

    // Default 404
    this.sendError(res, 404, "not_found");
  }
}
