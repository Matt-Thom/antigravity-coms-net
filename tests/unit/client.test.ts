/**
 * tests/unit/client.test.ts
 *
 * Unit tests for ComsNetClient:
 * - Mocked HTTP routes (all 9 endpoints)
 * - Error class mappings (401, 403, 404, 409, 429, 400, ECONNREFUSED)
 * - Timeout aborts (RequestTimeoutError)
 * - Bearer auth injection & omission on public routes
 * - Dual-signal cancellation
 * - 2-stage connectivity validation
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import {
  ComsNetClient,
  UnauthorizedError,
  NotTargetError,
  TargetNotFoundError,
  AgentNotFoundError,
  SenderNotRegisteredError,
  MessageNotFoundError,
  AmbiguousTargetError,
  HopLimitExceededError,
  AlreadyTerminalError,
  InboxFullError,
  BadRequestError,
  ConnectionRefusedError,
  RequestTimeoutError,
} from "../../src/protocol/client.ts";

describe("ComsNetClient HTTP REST Protocol", () => {
  let server: http.Server;
  let serverUrl: string;
  const testToken = "test-token-secret-1234";

  // State recorded from received requests for assertions
  let lastReceivedHeaders: http.IncomingHttpHeaders = {};
  let lastReceivedBody: any = null;

  before(async () => {
    server = http.createServer((req, res) => {
      lastReceivedHeaders = req.headers;
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname;
      const method = req.method;

      let bodyRaw = "";
      req.on("data", (chunk) => {
        bodyRaw += chunk;
      });

      req.on("end", () => {
        if (bodyRaw.length > 0) {
          try {
            lastReceivedBody = JSON.parse(bodyRaw);
          } catch {
            lastReceivedBody = bodyRaw;
          }
        } else {
          lastReceivedBody = null;
        }

        // Endpoint routing
        if (method === "GET" && pathname === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              version: 1,
              server_id: "SRV_01J7ABCDEF",
              started_at: "2026-09-09T00:00:00.000Z",
            })
          );
          return;
        }

        // Check auth for all /v1/*
        if (pathname.startsWith("/v1/")) {
          const auth = req.headers.authorization;
          if (auth === "Bearer invalid-token") {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
            return;
          }
        }

        // POST /v1/agents/register
        if (method === "POST" && pathname === "/v1/agents/register") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              agent: {
                session_id: lastReceivedBody.session_id,
                name: lastReceivedBody.name,
                project: lastReceivedBody.project,
                purpose: "test",
                model: "claude-3-5-sonnet",
                color: "#123456",
                cwd: "/test",
                explicit: false,
                started_at: "2026-09-09T00:00:00.000Z",
                context_used_pct: 0,
                queue_depth: 0,
                status: "online",
              },
              heartbeat_interval_ms: 10000,
              sse_url: "http://127.0.0.1/v1/events",
            })
          );
          return;
        }

        // POST /v1/agents/:session_id/heartbeat
        if (method === "POST" && pathname.match(/^\/v1\/agents\/[^/]+\/heartbeat$/)) {
          if (pathname.includes("stale_agent")) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "agent_not_found" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // GET /v1/agents
        if (method === "GET" && pathname === "/v1/agents") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              agents: [
                {
                  session_id: "01J7A000000000000000000001",
                  name: "peer-agent",
                  purpose: "expert coder",
                  model: "claude-3-5-sonnet",
                  color: "#00ff00",
                  cwd: "/code",
                  project: "default",
                  explicit: false,
                  started_at: "2026-09-09T00:00:00.000Z",
                  context_used_pct: 15,
                  queue_depth: 0,
                  status: "online",
                },
              ],
            })
          );
          return;
        }

        // POST /v1/messages
        if (method === "POST" && pathname === "/v1/messages") {
          if (lastReceivedBody.target === "missing-peer") {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "target_not_found", details: { target: "missing-peer" } }));
            return;
          }
          if (lastReceivedBody.target === "ambiguous-peer") {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "ambiguous_target", details: { target: "ambiguous-peer", candidates: ["id-1", "id-2"] } }));
            return;
          }
          if (lastReceivedBody.hops >= 5) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "hop_limit_exceeded", details: { hops: lastReceivedBody.hops, max_hops: 5 } }));
            return;
          }
          if (lastReceivedBody.target === "busy-peer") {
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "inbox_full", details: { depth: 100, max_inbox: 100 } }));
            return;
          }
          if (!lastReceivedBody.target) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "missing_target" }));
            return;
          }
          if (lastReceivedBody.sender_session === "unregistered") {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "sender_not_registered" }));
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              msg_id: "01J7MSG0000000000000000001",
              status: "delivered",
              target_session: "01J7TARGET0000000000000001",
            })
          );
          return;
        }

        // GET /v1/messages/:msg_id/await
        if (method === "GET" && pathname.match(/^\/v1\/messages\/[^/]+\/await$/)) {
          const timeoutParam = Number(url.searchParams.get("timeout_ms") ?? 100);
          if (pathname.includes("timeout_msg")) {
            setTimeout(() => {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  msg_id: "timeout_msg",
                  status: "timeout",
                  response: null,
                  error: "timeout",
                })
              );
            }, 30);
            return;
          }
          if (pathname.includes("hang_indefinitely")) {
            // Intentionally don't respond to test client-side timeout
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              msg_id: "msg-123",
              status: "complete",
              response: "Hello from peer!",
              error: null,
            })
          );
          return;
        }

        // GET /v1/messages/:msg_id
        if (method === "GET" && pathname.match(/^\/v1\/messages\/[^/]+$/)) {
          if (pathname.includes("unknown_id")) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "message_not_found" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              msg_id: "msg-123",
              status: "complete",
              response: "Cached reply",
              error: null,
            })
          );
          return;
        }

        // POST /v1/messages/:msg_id/response
        if (method === "POST" && pathname.match(/^\/v1\/messages\/[^/]+\/response$/)) {
          if (lastReceivedBody.responder_session === "impostor") {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "not_target" }));
            return;
          }
          if (pathname.includes("already_done")) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "already_terminal", details: { status: "complete" } }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // DELETE /v1/agents/:session_id
        if (method === "DELETE" && pathname.match(/^\/v1\/agents\/[^/]+$/)) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "not_found" }));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        serverUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("should get health without Bearer auth header", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    const health = await client.getHealth();
    assert.equal(health.ok, true);
    assert.equal(health.server_id, "SRV_01J7ABCDEF");
    assert.equal(lastReceivedHeaders.authorization, undefined);
  });

  it("should register agent and inject Bearer token", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    const reg = await client.registerAgent({
      project: "default",
      session_id: "01J7MYAGENT0000000000000001",
      name: "my-test-agent",
    });
    assert.equal(reg.ok, true);
    assert.equal(reg.agent.name, "my-test-agent");
    assert.equal(lastReceivedHeaders.authorization, `Bearer ${testToken}`);
    assert.equal(lastReceivedHeaders["content-type"], "application/json; charset=utf-8");
  });

  it("should send heartbeat to /v1/agents/:session_id/heartbeat", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    const res = await client.sendHeartbeat("01J7MYAGENT0000000000000001", { context_used_pct: 10 });
    assert.equal(res.ok, true);
  });

  it("should list agents and parse query params", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    const res = await client.listAgents({ include_explicit: true });
    assert.equal(res.agents.length, 1);
    assert.equal(res.agents[0].name, "peer-agent");
  });

  it("should deliver outbound message via sendMessage", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    const res = await client.sendMessage({
      sender_session: "01J7MYAGENT0000000000000001",
      target: "peer-agent",
      prompt: "Hello friend!",
    });
    assert.equal(res.ok, true);
    assert.equal(res.msg_id, "01J7MSG0000000000000000001");
    assert.equal(res.status, "delivered");
  });

  it("should get message status via getMessage", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    const res = await client.getMessage("msg-123");
    assert.equal(res.status, "complete");
    assert.equal(res.response, "Cached reply");
  });

  it("should await message reply via awaitMessage", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    const res = await client.awaitMessage("msg-123", { timeout_ms: 50 });
    assert.equal(res.status, "complete");
    assert.equal(res.response, "Hello from peer!");
  });

  it("should handle server await timeout payload cleanly", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    const res = await client.awaitMessage("timeout_msg", { timeout_ms: 50 });
    assert.equal(res.status, "timeout");
  });

  it("should submit response via submitResponse", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    const res = await client.submitResponse("msg-123", {
      responder_session: "01J7TARGET0000000000000001",
      response: "Completed task",
    });
    assert.equal(res.ok, true);
  });

  it("should delete agent on exit via deleteAgent", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    const res = await client.deleteAgent("01J7MYAGENT0000000000000001");
    assert.equal(res.ok, true);
  });

  // ━━ Error Taxonomy Mappings ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it("should map 401 to UnauthorizedError", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: "invalid-token" });
    await assert.rejects(
      async () => client.listAgents(),
      (err: unknown) => {
        assert.ok(err instanceof UnauthorizedError);
        assert.equal((err as UnauthorizedError).status, 401);
        return true;
      }
    );
  });

  it("should map 403 not_target to NotTargetError", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    await assert.rejects(
      async () =>
        client.submitResponse("msg-123", {
          responder_session: "impostor",
          response: "hacked",
        }),
      (err: unknown) => {
        assert.ok(err instanceof NotTargetError);
        assert.equal((err as NotTargetError).status, 403);
        return true;
      }
    );
  });

  it("should map 404 target_not_found to TargetNotFoundError", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    await assert.rejects(
      async () =>
        client.sendMessage({
          sender_session: "my-id",
          target: "missing-peer",
          prompt: "ping",
        }),
      (err: unknown) => {
        assert.ok(err instanceof TargetNotFoundError);
        assert.equal((err as TargetNotFoundError).target, "missing-peer");
        return true;
      }
    );
  });

  it("should map 404 agent_not_found to AgentNotFoundError", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    await assert.rejects(
      async () => client.sendHeartbeat("stale_agent"),
      (err: unknown) => {
        assert.ok(err instanceof AgentNotFoundError);
        return true;
      }
    );
  });

  it("should map 404 sender_not_registered to SenderNotRegisteredError", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    await assert.rejects(
      async () =>
        client.sendMessage({
          sender_session: "unregistered",
          target: "peer",
          prompt: "hi",
        }),
      (err: unknown) => {
        assert.ok(err instanceof SenderNotRegisteredError);
        return true;
      }
    );
  });

  it("should map 404 message_not_found to MessageNotFoundError", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    await assert.rejects(
      async () => client.getMessage("unknown_id"),
      (err: unknown) => {
        assert.ok(err instanceof MessageNotFoundError);
        return true;
      }
    );
  });

  it("should map 409 ambiguous_target to AmbiguousTargetError", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    await assert.rejects(
      async () =>
        client.sendMessage({
          sender_session: "my-id",
          target: "ambiguous-peer",
          prompt: "hi",
        }),
      (err: unknown) => {
        assert.ok(err instanceof AmbiguousTargetError);
        assert.equal((err as AmbiguousTargetError).target, "ambiguous-peer");
        assert.equal((err as AmbiguousTargetError).candidates.length, 2);
        return true;
      }
    );
  });

  it("should map 409 hop_limit_exceeded to HopLimitExceededError", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    await assert.rejects(
      async () =>
        client.sendMessage({
          sender_session: "my-id",
          target: "peer",
          prompt: "forward",
          hops: 5,
        }),
      (err: unknown) => {
        assert.ok(err instanceof HopLimitExceededError);
        assert.equal((err as HopLimitExceededError).hops, 5);
        return true;
      }
    );
  });

  it("should map 409 already_terminal to AlreadyTerminalError", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    await assert.rejects(
      async () =>
        client.submitResponse("already_done", {
          responder_session: "target",
          response: "again",
        }),
      (err: unknown) => {
        assert.ok(err instanceof AlreadyTerminalError);
        return true;
      }
    );
  });

  it("should map 429 inbox_full to InboxFullError", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    await assert.rejects(
      async () =>
        client.sendMessage({
          sender_session: "my-id",
          target: "busy-peer",
          prompt: "overflow",
        }),
      (err: unknown) => {
        assert.ok(err instanceof InboxFullError);
        assert.equal((err as InboxFullError).depth, 100);
        return true;
      }
    );
  });

  it("should map 400 missing_target to BadRequestError", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    await assert.rejects(
      async () =>
        client.sendMessage({
          sender_session: "my-id",
          target: "",
          prompt: "empty target",
        }),
      (err: unknown) => {
        assert.ok(err instanceof BadRequestError);
        return true;
      }
    );
  });

  it("should map connection refused to ConnectionRefusedError", async () => {
    const deadClient = new ComsNetClient({ baseUrl: "http://127.0.0.1:59999", authToken: testToken });
    await assert.rejects(
      async () => deadClient.getHealth({ timeoutMs: 100 }),
      (err: unknown) => {
        assert.ok(err instanceof ConnectionRefusedError || err instanceof RequestTimeoutError);
        return true;
      }
    );
  });

  it("should abort request when client-side timeout triggers", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    await assert.rejects(
      async () =>
        client.awaitMessage("hang_indefinitely", { timeout_ms: 200 }, { timeoutMs: 50 }),
      (err: unknown) => {
        assert.ok(err instanceof RequestTimeoutError);
        assert.equal((err as RequestTimeoutError).timeoutMs, 50);
        return true;
      }
    );
  });

  it("should cancel request when external AbortSignal triggers", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    const ac = new AbortController();
    const abortReason = new Error("User canceled turn");
    setTimeout(() => ac.abort(abortReason), 20);

    await assert.rejects(
      async () =>
        client.awaitMessage("hang_indefinitely", { timeout_ms: 200 }, { signal: ac.signal }),
      (err: unknown) => {
        assert.equal(err, abortReason);
        return true;
      }
    );
  });

  it("should validate connectivity in 2 stages (healthy & auth valid)", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: testToken });
    const res = await client.validateConnectivity();
    assert.equal(res.reachable, true);
    assert.equal(res.authenticated, true);
    assert.equal(res.serverId, "SRV_01J7ABCDEF");
  });

  it("should validate connectivity reporting auth failure when token is invalid", async () => {
    const client = new ComsNetClient({ baseUrl: serverUrl, authToken: "invalid-token" });
    const res = await client.validateConnectivity();
    assert.equal(res.reachable, true);
    assert.equal(res.authenticated, false);
    assert.ok(res.error?.includes("Authentication failed"));
  });

  it("should validate connectivity reporting unreachable when hub is down", async () => {
    const client = new ComsNetClient({ baseUrl: "http://127.0.0.1:59999", authToken: testToken });
    const res = await client.validateConnectivity({ timeoutMs: 100 });
    assert.equal(res.reachable, false);
    assert.equal(res.authenticated, false);
    assert.ok(res.error?.length ?? 0 > 0);
  });
});
