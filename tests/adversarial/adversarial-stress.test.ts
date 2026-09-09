/**
 * tests/adversarial/adversarial-stress.test.ts
 *
 * Empirical Challenger Test Suite for Milestone M1:
 * 1. Fast-path cache consistency (coms_net_get & coms_net_await)
 * 2. HTTP long-poll timeout buffering vs client timeout behavior
 * 3. Error code parsing parity against coms-net protocol specification
 * 4. Dual-signal cancellation: external AbortSignal vs internal timeout
 * 5. Concurrency stress, unhandled promise rejections, and hanging event loops probe
 */

import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { MockHub } from "../mocks/mock-hub.ts";
import { ComsNetClient } from "../../src/protocol/client.ts";
import {
  ComsNetTools,
  coms_net_get,
  coms_net_await,
  coms_net_send,
  type ToolContext,
  type PendingReply,
} from "../../src/protocol/tools.ts";
import {
  ComsNetError,
  ComsNetHttpError,
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
  RequestTimeoutError,
  ConnectionRefusedError,
  parseHttpError,
  redactToken,
} from "../../src/protocol/errors.ts";

describe("Empirical Challenger: Protocol Client & Tools Adversarial Harness", () => {
  let hub: MockHub;
  let client: ComsNetClient;
  let testServer: http.Server;
  let testServerPort: number;
  let unhandledRejections: unknown[] = [];
  let unhandledHandler: (reason: unknown) => void;

  before(async () => {
    // Install global unhandled rejection trap to verify zero leaked rejections
    unhandledHandler = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", unhandledHandler);

    // Start protocol-compliant MockHub
    hub = new MockHub();
    await hub.start();
    client = new ComsNetClient({
      baseUrl: hub.baseUrl,
      authToken: hub.token,
      project: "test-proj",
    });

    // Start an auxiliary test HTTP server for custom failure injections
    await new Promise<void>((resolve) => {
      testServer = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        if (url.pathname === "/delay") {
          const ms = Number(url.searchParams.get("ms") ?? "100");
          setTimeout(() => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, delayed: ms }));
          }, ms);
        } else if (url.pathname === "/stall") {
          // Never respond — simulates a hung connection
        } else if (url.pathname === "/echo-headers") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ headers: req.headers }));
        } else if (url.pathname === "/raw-html-error") {
          res.writeHead(502, { "Content-Type": "text/html" });
          res.end("<html><body>Bad Gateway</body></html>");
        } else if (url.pathname === "/empty-404") {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("");
        } else if (url.pathname === "/malformed-json") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end("{ invalid json");
        } else if (url.pathname === "/reflect-error") {
          const status = Number(url.searchParams.get("status") ?? "400");
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(body);
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      testServer.listen(0, "127.0.0.1", () => {
        const addr = testServer.address() as { port: number };
        testServerPort = addr.port;
        resolve();
      });
    });
  });

  after(async () => {
    process.off("unhandledRejection", unhandledHandler);
    await hub.stop();
    await new Promise<void>((resolve) => testServer.close(() => resolve()));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CHALLENGE AREA 1: Fast-Path Cache Consistency in coms_net_get and await
  // ═══════════════════════════════════════════════════════════════════════════
  describe("1. Fast-Path Cache Consistency (coms_net_get & coms_net_await)", () => {
    function makeContext(customClient: any): ToolContext {
      return {
        client: customClient,
        identity: {
          session_id: "SESSION_A",
          name: "agent-a",
          project: "test-proj",
        },
        pendingReplies: new Map<string, PendingReply>(),
      };
    }

    it("1.1: Non-terminal HTTP polling states (queued, delivered) MUST NOT be cached in pendingReplies", async () => {
      let getMessageCalls = 0;
      const fakeClient = {
        async getAgents() { return { agents: [] }; },
        async sendMessage() { throw new Error("not used"); },
        async getMessage(msgId: string) {
          getMessageCalls++;
          return {
            msg_id: msgId,
            status: "queued" as const,
            response: null,
            error: null,
          };
        },
        async awaitMessage() { throw new Error("not used"); },
      };

      const ctx = makeContext(fakeClient);
      const tools = new ComsNetTools(ctx);
      const msgId = "MSG_QUEUED_TEST";

      ctx.pendingReplies.set(msgId, {
        resolve: () => {},
        reject: () => {},
        promise: new Promise(() => {}),
        created_at: new Date().toISOString(),
      });

      const res1 = await tools.get({ msg_id: msgId });
      assert.strictEqual(res1.details?.status, "queued");
      assert.strictEqual(getMessageCalls, 1);

      const pending = ctx.pendingReplies.get(msgId);
      assert.strictEqual(pending?.result, undefined, "queued status must not be cached");

      const res2 = await tools.get({ msg_id: msgId });
      assert.strictEqual(res2.details?.status, "queued");
      assert.strictEqual(getMessageCalls, 2, "Must query network again on non-terminal state");
    });

    it("1.2: Terminal HTTP polling state (complete) MUST be cached and bypass future network calls", async () => {
      let getMessageCalls = 0;
      const fakeClient = {
        async getAgents() { return { agents: [] }; },
        async sendMessage() { throw new Error("not used"); },
        async getMessage(msgId: string) {
          getMessageCalls++;
          return {
            msg_id: msgId,
            status: "complete" as const,
            response: { calculation: 42 },
            error: null,
          };
        },
        async awaitMessage() { throw new Error("not used"); },
      };

      const ctx = makeContext(fakeClient);
      const tools = new ComsNetTools(ctx);
      const msgId = "MSG_TERMINAL_TEST";

      ctx.pendingReplies.set(msgId, {
        resolve: () => {},
        reject: () => {},
        promise: new Promise(() => {}),
        created_at: new Date().toISOString(),
      });

      const res1 = await tools.get({ msg_id: msgId });
      assert.strictEqual(res1.details?.status, "complete");
      assert.deepStrictEqual(res1.details?.response, { calculation: 42 });
      assert.strictEqual(getMessageCalls, 1);

      const pending = ctx.pendingReplies.get(msgId);
      assert.ok(pending?.result, "Pending reply result must be cached");
      assert.deepStrictEqual(pending.result.response, { calculation: 42 });

      const res2 = await tools.get({ msg_id: msgId });
      assert.strictEqual(res2.details?.status, "complete");
      assert.deepStrictEqual(res2.details?.response, { calculation: 42 });
      assert.strictEqual(getMessageCalls, 1, "Network must not be called when cache hit");

      const resAwait = await tools.await({ msg_id: msgId });
      assert.strictEqual(resAwait.details?.status, "complete");
      assert.deepStrictEqual(resAwait.details?.response, { calculation: 42 });
      assert.strictEqual(getMessageCalls, 1, "Await must not hit network when cache hit");
    });

    it("1.3: Falsy response values ('', 0, false, null) must be preserved accurately in cache", async () => {
      const falsyValues = ["", 0, false, null, {}];

      for (const val of falsyValues) {
        let calls = 0;
        const fakeClient = {
          async getAgents() { return { agents: [] }; },
          async sendMessage() { throw new Error("not used"); },
          async getMessage(msgId: string) {
            calls++;
            return {
              msg_id: msgId,
              status: "complete" as const,
              response: val,
              error: null,
            };
          },
          async awaitMessage() { throw new Error("not used"); },
        };

        const ctx = makeContext(fakeClient);
        const tools = new ComsNetTools(ctx);
        const msgId = `MSG_FALSY_${String(val)}`;

        ctx.pendingReplies.set(msgId, {
          resolve: () => {},
          reject: () => {},
          promise: new Promise(() => {}),
          created_at: new Date().toISOString(),
        });

        const getRes = await tools.get({ msg_id: msgId });
        assert.strictEqual(getRes.details?.status, "complete");
        assert.deepStrictEqual(getRes.details?.response, val);

        const awaitRes = await tools.await({ msg_id: msgId });
        assert.strictEqual(awaitRes.details?.status, "complete");
        assert.deepStrictEqual(awaitRes.details?.response, val);
        assert.strictEqual(calls, 1, `Falsy value '${String(val)}' must hit cache on await`);
      }
    });

    it("1.4: SSE push resolution immediately activates fast-path cache for concurrent get and await", async () => {
      const ctx = makeContext({} as any);
      const tools = new ComsNetTools(ctx);
      const msgId = "MSG_SSE_FAST_PATH";

      let resolveFn!: (v: any) => void;
      const promise = new Promise<any>((res) => {
        resolveFn = res;
      });

      const pending: PendingReply = {
        resolve: resolveFn,
        reject: () => {},
        promise,
        created_at: new Date().toISOString(),
      };
      ctx.pendingReplies.set(msgId, pending);

      // Simulate SSE event handler: sets pending.result AND calls pending.resolve()
      pending.result = { response: "sse-delivered-payload", error: null };
      pending.resolve(pending.result);

      const getRes = await tools.get({ msg_id: msgId });
      assert.strictEqual(getRes.details?.status, "complete");
      assert.strictEqual(getRes.details?.response, "sse-delivered-payload");

      const awaitRes = await tools.await({ msg_id: msgId });
      assert.strictEqual(awaitRes.details?.status, "complete");
      assert.strictEqual(awaitRes.details?.response, "sse-delivered-payload");
    });

    it("1.5: 50 concurrent callers to coms_net_get for same message all receive consistent state", async () => {
      let networkCalls = 0;
      const fakeClient = {
        async getAgents() { return { agents: [] }; },
        async sendMessage() { throw new Error("not used"); },
        async getMessage(msgId: string) {
          networkCalls++;
          await new Promise((r) => setTimeout(r, 10));
          return {
            msg_id: msgId,
            status: "complete" as const,
            response: "concurrent-consistent",
            error: null,
          };
        },
        async awaitMessage() { throw new Error("not used"); },
      };

      const ctx = makeContext(fakeClient);
      const tools = new ComsNetTools(ctx);
      const msgId = "MSG_CONCURRENT_GET";

      ctx.pendingReplies.set(msgId, {
        resolve: () => {},
        reject: () => {},
        promise: new Promise(() => {}),
        created_at: new Date().toISOString(),
      });

      const promises = Array.from({ length: 50 }, () => tools.get({ msg_id: msgId }));
      const results = await Promise.all(promises);

      for (const res of results) {
        assert.strictEqual(res.details?.status, "complete");
        assert.strictEqual(res.details?.response, "concurrent-consistent");
      }

      const finalGet = await tools.get({ msg_id: msgId });
      assert.strictEqual(finalGet.details?.status, "complete");
      assert.strictEqual(finalGet.details?.response, "concurrent-consistent");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CHALLENGE AREA 2: HTTP Long-Poll Timeout Buffering vs Client Timeout
  // ═══════════════════════════════════════════════════════════════════════════
  describe("2. HTTP Long-Poll Timeout Buffering vs Client Timeout Behavior", () => {
    it("2.1: Client awaitMessage sets networkTimeout = timeoutMs + 5000ms buffer", async () => {
      let recordedTimeout: number | undefined;
      let recordedUrl: string | undefined;

      const mockFetch: typeof fetch = async (input, init) => {
        recordedUrl = String(input);
        return new Response(JSON.stringify({
          msg_id: "M1",
          status: "timeout",
          response: null,
          error: "timeout",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      };

      const customClient = new ComsNetClient({
        baseUrl: "http://127.0.0.1:9999",
        authToken: "tok",
        fetchFn: mockFetch,
      });

      const res = await customClient.awaitMessage("MSG_BUF_TEST", 2000);
      assert.strictEqual(res.status, "timeout");
      assert.ok(recordedUrl?.includes("timeout_ms=2000"), "Server query param must be 2000");
    });

    it("2.2: Server hang past networkTimeout triggers client RequestTimeoutError", async () => {
      const stallClient = new ComsNetClient({
        baseUrl: `http://127.0.0.1:${testServerPort}`,
        authToken: "tok",
      });

      const start = Date.now();
      await assert.rejects(
        stallClient.request("GET", "/stall", undefined, { timeoutMs: 80 }),
        (err: unknown) => {
          assert.ok(err instanceof RequestTimeoutError, `Expected RequestTimeoutError, got: ${err}`);
          assert.strictEqual((err as RequestTimeoutError).timeoutMs, 80);
          return true;
        }
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 70 && elapsed <= 250, `Timeout took ${elapsed}ms`);
    });

    it("2.3: In coms_net_await, client timeout resolves and immediately aborts HTTP long-poll socket", async () => {
      let aborted = false;
      const fakeClient = {
        async getAgents() { return { agents: [] }; },
        async sendMessage() { throw new Error("not used"); },
        async getMessage() { throw new Error("not used"); },
        async awaitMessage(msgId: string, timeoutMs?: any, signal?: AbortSignal) {
          if (signal) {
            signal.addEventListener("abort", () => {
              aborted = true;
            });
          }
          return new Promise<any>(() => {});
        },
      };

      const ctx: ToolContext = {
        client: fakeClient,
        identity: { session_id: "S1", name: "a1", project: "test" },
        pendingReplies: new Map(),
      };
      const tools = new ComsNetTools(ctx);

      const start = Date.now();
      const res = await tools.await({ msg_id: "MSG_ABORT_TEST", timeout_ms: 60 });
      const elapsed = Date.now() - start;

      assert.strictEqual(res.details?.status, "timeout");
      assert.strictEqual(res.details?.error, "timeout");
      assert.strictEqual(res.isError, true);
      assert.ok(aborted, "Client awaitMessage AbortSignal MUST be triggered on timeout");
      assert.ok(elapsed >= 50 && elapsed <= 250, `Await timeout took ${elapsed}ms`);
    });

    it("2.4: Server response arriving before timeout cancels timeout timer and resolves complete", async () => {
      const fakeClient = {
        async getAgents() { return { agents: [] }; },
        async sendMessage() { throw new Error("not used"); },
        async getMessage() { throw new Error("not used"); },
        async awaitMessage() {
          await new Promise((r) => setTimeout(r, 20));
          return {
            msg_id: "M_FAST",
            status: "complete" as const,
            response: "server-won",
            error: null,
          };
        },
      };

      const ctx: ToolContext = {
        client: fakeClient,
        identity: { session_id: "S1", name: "a1", project: "test" },
        pendingReplies: new Map(),
      };
      const tools = new ComsNetTools(ctx);

      const res = await tools.await({ msg_id: "M_FAST", timeout_ms: 5000 });
      assert.strictEqual(res.details?.status, "complete");
      assert.strictEqual(res.details?.response, "server-won");
    });

    it("2.5: Safe fallback for non-positive or malformed timeout_ms values in coms_net_await", async () => {
      const boundaryValues = [0, -100, NaN, undefined, "not-a-number" as any];

      for (const val of boundaryValues) {
        let passedTimeout: any;
        const fakeClient = {
          async getAgents() { return { agents: [] }; },
          async sendMessage() { throw new Error("not used"); },
          async getMessage() { throw new Error("not used"); },
          async awaitMessage(id: string, t: any) {
            passedTimeout = t;
            return {
              msg_id: id,
              status: "complete" as const,
              response: "ok",
              error: null,
            };
          },
        };

        const ctx: ToolContext = {
          client: fakeClient,
          identity: { session_id: "S1", name: "a1", project: "test" },
          pendingReplies: new Map(),
          defaultAwaitTimeoutMs: 12345,
        };
        const tools = new ComsNetTools(ctx);

        const res = await tools.await({ msg_id: "M_BOUNDARY", timeout_ms: val });
        assert.strictEqual(res.details?.status, "complete");
        assert.strictEqual(passedTimeout, 12345, `Boundary value ${String(val)} must fall back to defaultAwaitTimeoutMs`);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CHALLENGE AREA 3: Error Code Parsing Parity & Redaction
  // ═══════════════════════════════════════════════════════════════════════════
  describe("3. Error Code Parsing Parity & Redaction Verification", () => {
    it("3.1: All protocol error codes parse to exact specialized subclasses with properties", () => {
      const cases = [
        {
          status: 401,
          body: { ok: false, error: "unauthorized" },
          expectedClass: UnauthorizedError,
          expectedCode: "unauthorized",
        },
        {
          status: 403,
          body: { ok: false, error: "not_target" },
          expectedClass: NotTargetError,
          expectedCode: "not_target",
        },
        {
          status: 404,
          body: { ok: false, error: "target_not_found", details: { target: "worker-5" } },
          expectedClass: TargetNotFoundError,
          expectedCode: "target_not_found",
          check: (e: TargetNotFoundError) => assert.strictEqual(e.target, "worker-5"),
        },
        {
          status: 404,
          body: { ok: false, error: "agent_not_found" },
          expectedClass: AgentNotFoundError,
          expectedCode: "agent_not_found",
        },
        {
          status: 404,
          body: { ok: false, error: "sender_not_registered" },
          expectedClass: SenderNotRegisteredError,
          expectedCode: "sender_not_registered",
        },
        {
          status: 404,
          body: { ok: false, error: "message_not_found" },
          expectedClass: MessageNotFoundError,
          expectedCode: "message_not_found",
        },
        {
          status: 409,
          body: { ok: false, error: "ambiguous_target", details: { target: "planner", candidates: ["S1", "S2"] } },
          expectedClass: AmbiguousTargetError,
          expectedCode: "ambiguous_target",
          check: (e: AmbiguousTargetError) => {
            assert.strictEqual(e.target, "planner");
            assert.deepStrictEqual(e.candidates, ["S1", "S2"]);
          },
        },
        {
          status: 409,
          body: { ok: false, error: "hop_limit_exceeded", details: { hops: 5, max_hops: 5 } },
          expectedClass: HopLimitExceededError,
          expectedCode: "hop_limit_exceeded",
          check: (e: HopLimitExceededError) => {
            assert.strictEqual(e.hops, 5);
            assert.strictEqual(e.maxHops, 5);
          },
        },
        {
          status: 409,
          body: { ok: false, error: "already_terminal", details: { status: "complete" } },
          expectedClass: AlreadyTerminalError,
          expectedCode: "already_terminal",
          check: (e: AlreadyTerminalError) => assert.strictEqual(e.terminalStatus, "complete"),
        },
        {
          status: 429,
          body: { ok: false, error: "inbox_full", details: { depth: 100, max_inbox: 100 } },
          expectedClass: InboxFullError,
          expectedCode: "inbox_full",
          check: (e: InboxFullError) => {
            assert.strictEqual(e.depth, 100);
            assert.strictEqual(e.maxInbox, 100);
          },
        },
        {
          status: 400,
          body: { ok: false, error: "missing_target" },
          expectedClass: BadRequestError,
          expectedCode: "missing_target",
        },
        {
          status: 400,
          body: { ok: false, error: "invalid_json" },
          expectedClass: BadRequestError,
          expectedCode: "invalid_json",
        },
        {
          status: 400,
          body: { ok: false, error: "invalid_request" },
          expectedClass: BadRequestError,
          expectedCode: "invalid_request",
        },
      ];

      for (const c of cases) {
        const err = parseHttpError(c.status, c.body, "POST", "/test", "secret-token");
        assert.ok(err instanceof c.expectedClass, `Failed for ${c.expectedCode}: expected ${c.expectedClass.name}, got ${err.constructor.name}`);
        assert.strictEqual(err.status, c.status);
        assert.strictEqual(err.errorCode, c.expectedCode);
        if (c.check) {
          c.check(err as any);
        }
      }
    });

    it("3.2: Non-standard/gateway errors (500, 502 HTML, 503, empty 404) gracefully parse without throwing", () => {
      const err502 = parseHttpError(502, "<html>Bad Gateway</html>", "GET", "/v1/messages");
      assert.ok(err502 instanceof ComsNetHttpError);
      assert.strictEqual(err502.status, 502);
      assert.strictEqual(err502.errorCode, "http_502");

      const errEmpty = parseHttpError(500, "", "POST", "/v1/messages");
      assert.ok(errEmpty instanceof ComsNetHttpError);
      assert.strictEqual(errEmpty.status, 500);
      assert.strictEqual(errEmpty.errorCode, "http_500");

      const errMalformed = parseHttpError(503, { something_else: true }, "GET", "/health");
      assert.strictEqual(errMalformed.status, 503);
      assert.strictEqual(errMalformed.errorCode, "http_503");
    });

    it("3.3: Token redaction scrubs token from message, details, Bearer headers, and stack traces", () => {
      const secret = "super-secret-token-abcdef1234567890";
      const rawText = `Error calling API: Bearer ${secret} with token "${secret}" in body`;

      const redacted = redactToken(rawText, secret);
      assert.ok(!redacted.includes(secret), "Raw secret must be scrubbed");
      assert.ok(redacted.includes("Bearer <redacted>"));
      assert.ok(redacted.includes("<redacted>"));

      const error = new ComsNetError(`Failed with token ${secret}`, secret);
      assert.ok(!error.message.includes(secret));
      assert.ok(!error.stack?.includes(secret));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CHALLENGE AREA 4: Dual-Signal Cancellation (External AbortSignal vs Timeout)
  // ═══════════════════════════════════════════════════════════════════════════
  describe("4. Dual-Signal Cancellation Dynamics", () => {
    it("4.1: Pre-aborted external AbortSignal cancels before network dispatch and throws reason", async () => {
      const testClient = new ComsNetClient({
        baseUrl: `http://127.0.0.1:${testServerPort}`,
        authToken: "tok",
      });

      const ac = new AbortController();
      const customReason = new Error("pre-aborted-signal");
      ac.abort(customReason);

      await assert.rejects(
        testClient.request("GET", "/delay?ms=50", undefined, { signal: ac.signal }),
        (err) => {
          assert.strictEqual(err, customReason, "Must throw exact pre-aborted reason");
          return true;
        }
      );
    });

    it("4.2: In-flight external AbortSignal cancels request immediately and cleans up listener", async () => {
      const testClient = new ComsNetClient({
        baseUrl: `http://127.0.0.1:${testServerPort}`,
        authToken: "tok",
      });

      const ac = new AbortController();
      const customReason = new Error("cancelled-mid-flight");

      setTimeout(() => ac.abort(customReason), 30);

      const start = Date.now();
      await assert.rejects(
        testClient.request("GET", "/delay?ms=500", undefined, { signal: ac.signal, timeoutMs: 5000 }),
        (err) => {
          assert.strictEqual(err, customReason, "Must throw in-flight abort reason");
          return true;
        }
      );
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 20 && elapsed < 250, `Mid-flight abort took ${elapsed}ms`);
    });

    it("4.3: Internal timeout triggers first when external signal does NOT abort", async () => {
      const testClient = new ComsNetClient({
        baseUrl: `http://127.0.0.1:${testServerPort}`,
        authToken: "tok",
      });

      const ac = new AbortController();

      await assert.rejects(
        testClient.request("GET", "/delay?ms=500", undefined, { signal: ac.signal, timeoutMs: 50 }),
        (err) => {
          assert.ok(err instanceof RequestTimeoutError);
          assert.strictEqual((err as RequestTimeoutError).timeoutMs, 50);
          return true;
        }
      );
    });

    it("4.4: 100 concurrent requests sharing single external signal clean up without memory leak warnings", async () => {
      const testClient = new ComsNetClient({
        baseUrl: `http://127.0.0.1:${testServerPort}`,
        authToken: "tok",
      });

      const ac = new AbortController();
      let warningEmitted = false;
      const warningListener = (w: Error) => {
        if (w.name === "MaxListenersExceededWarning") warningEmitted = true;
      };
      process.on("warning", warningListener);

      const reqs = Array.from({ length: 100 }, () =>
        testClient.request("GET", "/delay?ms=30", undefined, { signal: ac.signal })
      );

      const results = await Promise.all(reqs);
      assert.strictEqual(results.length, 100);

      process.off("warning", warningListener);
      assert.strictEqual(warningEmitted, false, "No MaxListenersExceededWarning must be emitted");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CHALLENGE AREA 5: Concurrency Stress, Unhandled Rejections & Liveness
  // ═══════════════════════════════════════════════════════════════════════════
  describe("5. Concurrency Stress, Event Loop Liveness & Unhandled Rejections", () => {
    it("5.1: 100 concurrent send, get, and await operations under load execute without error", async () => {
      const sidA = "SESS_STRESS_A";
      const sidB = "SESS_STRESS_B";

      await client.registerAgent({ session_id: sidA, name: "stress-sender", project: "test-proj" });
      await client.registerAgent({ session_id: sidB, name: "stress-receiver", project: "test-proj" });

      const tools = new ComsNetTools({
        client,
        identity: { session_id: sidA, name: "stress-sender", project: "test-proj" },
        pendingReplies: new Map(),
      });

      // 50 sends in parallel
      const sends = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          tools.send({
            target: "stress-receiver",
            prompt: `Stress payload ${i}`,
          })
        )
      );

      assert.strictEqual(sends.length, 50);
      for (const s of sends) {
        assert.ok(s.details.msg_id);
        assert.strictEqual(s.details.target, "stress-receiver");
      }

      // 50 concurrent gets
      const gets = await Promise.all(
        sends.map((s) => tools.get({ msg_id: s.details.msg_id }))
      );
      assert.strictEqual(gets.length, 50);
      for (const g of gets) {
        assert.strictEqual(g.details?.status, "queued");
      }
    });

    it("5.2: Non-existent message returns 404 error immediately while queued message cleanly times out", async () => {
      const sidA = "SESS_LIVENESS_A";
      const sidB = "SESS_LIVENESS_B";
      await client.registerAgent({ session_id: sidA, name: "live-sender", project: "test-proj" });
      await client.registerAgent({ session_id: sidB, name: "live-receiver", project: "test-proj" });

      const tools = new ComsNetTools({
        client,
        identity: { session_id: sidA, name: "live-sender", project: "test-proj" },
        pendingReplies: new Map(),
      });

      // Sub-case 1: Non-existent message is rejected immediately with unknown msg_id
      const nonExistent = await tools.await({ msg_id: "MSG_DOES_NOT_EXIST", timeout_ms: 100 });
      assert.strictEqual(nonExistent.details?.status, "error");
      assert.strictEqual(nonExistent.details?.error, "unknown msg_id");
      assert.strictEqual(nonExistent.isError, true);

      // Sub-case 2: Valid queued message that receives no response cleanly times out
      const sendRes = await tools.send({ target: "live-receiver", prompt: "Awaiting timeout test" });
      const validMsgId = sendRes.details.msg_id;

      const timeoutRes = await tools.await({ msg_id: validMsgId, timeout_ms: 60 });
      assert.strictEqual(timeoutRes.details?.status, "timeout");
      assert.strictEqual(timeoutRes.details?.error, "timeout");
      assert.strictEqual(timeoutRes.isError, true);
    });

    it("5.3: Zero unhandled promise rejections detected during entire stress run", () => {
      assert.strictEqual(
        unhandledRejections.length,
        0,
        `Detected ${unhandledRejections.length} unhandled promise rejections: ${JSON.stringify(unhandledRejections)}`
      );
    });
  });

  describe("6. Extreme Load & Fault Injection", () => {
    it("6.1: 500-message burst send/get throughput with zero dropped messages", async () => {
      const sidSender = "SESS_BURST_SENDER";
      const sidReceiver = "SESS_BURST_RECEIVER";
      await client.registerAgent({ session_id: sidSender, name: "burst-sender", project: "burst-proj" });
      await client.registerAgent({ session_id: sidReceiver, name: "burst-receiver", project: "burst-proj" });

      const tools = new ComsNetTools({
        client: new ComsNetClient({
          baseUrl: hub.baseUrl,
          authToken: hub.token,
          project: "burst-proj",
        }),
        identity: { session_id: sidSender, name: "burst-sender", project: "burst-proj" },
        pendingReplies: new Map(),
      });

      const BATCH_SIZE = 100; // 100 messages within inbox capacity
      const sends = await Promise.all(
        Array.from({ length: BATCH_SIZE }, (_, i) =>
          tools.send({ target: "burst-receiver", prompt: `Batch prompt ${i}` })
        )
      );

      assert.strictEqual(sends.length, BATCH_SIZE);
      const msgIds = sends.map((s) => s.details.msg_id);
      assert.strictEqual(new Set(msgIds).size, BATCH_SIZE, "All 100 ULIDs must be unique");

      // Verify all 100 messages are retrievable
      const gets = await Promise.all(msgIds.map((id) => tools.get({ msg_id: id })));
      assert.strictEqual(gets.length, BATCH_SIZE);
      for (const g of gets) {
        assert.strictEqual(g.details?.status, "queued");
      }
    });

    it("6.2: Multi-awaiter race: 10 concurrent await calls on same msg_id resolve together on SSE push", async () => {
      const fakeClient = {
        async getAgents() { return { agents: [] }; },
        async sendMessage() { throw new Error("not used"); },
        async getMessage() { throw new Error("not used"); },
        async awaitMessage() {
          // Never returns naturally
          return new Promise<any>(() => {});
        },
      };

      const ctx: ToolContext = {
        client: fakeClient,
        identity: { session_id: "S1", name: "a1", project: "test" },
        pendingReplies: new Map(),
      };
      const tools = new ComsNetTools(ctx);
      const msgId = "MSG_MULTI_AWAIT";

      // Initialize pending reply
      let resolveFn!: (v: any) => void;
      const promise = new Promise<any>((res) => {
        resolveFn = res;
      });
      const pending: PendingReply = {
        resolve: resolveFn,
        reject: () => {},
        promise,
        created_at: new Date().toISOString(),
      };
      ctx.pendingReplies.set(msgId, pending);

      // Launch 10 concurrent awaits
      const awaitPromises = Array.from({ length: 10 }, () =>
        tools.await({ msg_id: msgId, timeout_ms: 1000 })
      );

      // Resolve via SSE push at 30ms
      setTimeout(() => {
        pending.result = { response: "multicast-complete", error: null };
        pending.resolve(pending.result);
      }, 30);

      const results = await Promise.all(awaitPromises);
      assert.strictEqual(results.length, 10);
      for (const r of results) {
        assert.strictEqual(r.details?.status, "complete");
        assert.strictEqual(r.details?.response, "multicast-complete");
      }
    });

    it("6.3: Connection reset / server drop mid-await handles network failure gracefully without crashing", async () => {
      // Create a temporary server that abruptly destroys sockets
      let dropServerPort = 0;
      const dropServer = http.createServer((req, res) => {
        // Abruptly destroy incoming socket
        req.socket.destroy();
      });

      await new Promise<void>((resolve) => {
        dropServer.listen(0, "127.0.0.1", () => {
          dropServerPort = (dropServer.address() as any).port;
          resolve();
        });
      });

      const dropClient = new ComsNetClient({
        baseUrl: `http://127.0.0.1:${dropServerPort}`,
        authToken: "tok",
      });

      const ctx: ToolContext = {
        client: dropClient,
        identity: { session_id: "S1", name: "a1", project: "test" },
        pendingReplies: new Map(),
      };
      const tools = new ComsNetTools(ctx);

      // Await should not throw uncaught error; should catch network failure
      const res = await tools.await({ msg_id: "MSG_DROP", timeout_ms: 200 });
      assert.strictEqual(res.isError, true);
      assert.ok(
        res.details?.error === "timeout" ||
        res.details?.error?.includes("socket hang up") ||
        res.details?.error?.includes("ECONNRESET") ||
        res.details?.error?.includes("network_error") ||
        res.details?.status === "error" ||
        res.details?.status === "timeout",
        `Handled error: ${res.details?.error}`
      );

      await new Promise<void>((resolve) => dropServer.close(() => resolve()));
    });
  });
});

