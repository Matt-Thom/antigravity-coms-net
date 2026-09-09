/**
 * tests/unit/tools.test.ts
 *
 * Unit tests for ComsNetTools:
 * - Hop limit enforcement & rejection (hops >= 5)
 * - Inbound context hop propagation
 * - 3-way race resolution in coms_net_await:
 *   - Local SSE promise resolution
 *   - Server HTTP await resolution
 *   - Timeout resolution
 *   - Immediate abort of HTTP long-poll
 * - Peer filtering (excludes caller's own session) & status formatting
 * - Fast-path cache hits in get and await
 * - ULID Crockford Base32 generation
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  ComsNetTools,
  generateUlid,
  abbreviateModel,
  formatPeerRoster,
  CROCKFORD_ALPHABET,
  type ToolContext,
  type PendingReply,
  type IComsClient,
  type InboundContext,
} from "../../src/protocol/tools.ts";
import { HopLimitExceededError } from "../../src/protocol/errors.ts";
import type { AgentCard } from "../../src/protocol/types.ts";

describe("ComsNetTools Protocol Implementations", () => {
  let mockClient: IComsClient;
  let pendingReplies: Map<string, PendingReply>;
  let currentInbound: InboundContext | null;
  let inboundQueue: Map<string, InboundContext>;
  let toolCtx: ToolContext;

  const myIdentity = {
    session_id: "01J7SELF000000000000000001",
    name: "worker-agent",
    project: "default",
    cwd: "/home/matt/code",
  };

  beforeEach(() => {
    pendingReplies = new Map<string, PendingReply>();
    currentInbound = null;
    inboundQueue = new Map<string, InboundContext>();

    mockClient = {
      async getAgents(project?: string, includeExplicit?: boolean) {
        return {
          agents: [
            {
              session_id: myIdentity.session_id,
              name: myIdentity.name,
              purpose: "self",
              model: "claude-3-5-sonnet",
              color: "#000000",
              cwd: myIdentity.cwd,
              project: "default",
              explicit: false,
              started_at: "2026-09-09T00:00:00Z",
              context_used_pct: 10,
              queue_depth: 0,
              status: "online",
            },
            {
              session_id: "01J7PEER000000000000000002",
              name: "peer-agent",
              purpose: "code review",
              model: "claude-3-opus-20240229",
              color: "#36F9F6",
              cwd: "/home/matt/peer",
              project: "default",
              explicit: false,
              started_at: "2026-09-09T00:00:00Z",
              context_used_pct: 45,
              queue_depth: 1,
              status: "online",
            },
            {
              session_id: "01J7STALE00000000000000003",
              name: "stale-peer",
              purpose: "idle researcher",
              model: "gpt-4o",
              color: "#FF5500",
              cwd: "/home/matt/stale",
              project: "default",
              explicit: false,
              started_at: "2026-09-09T00:00:00Z",
              context_used_pct: 0,
              queue_depth: 0,
              status: "stale",
            },
          ],
        };
      },
      async sendMessage(params) {
        return {
          ok: true,
          msg_id: "01J7SRVMSG0000000000000001",
          status: "delivered",
          target_session: "01J7PEER000000000000000002",
        };
      },
      async getMessage(msg_id: string) {
        if (msg_id === "unknown-id") {
          const err: any = new Error("Not Found");
          err.status = 404;
          throw err;
        }
        return {
          msg_id,
          status: "complete",
          response: "Remote result",
          error: null,
        };
      },
      async awaitMessage(msg_id: string, timeoutMs: any, signal?: any) {
        return {
          msg_id,
          status: "complete",
          response: "Long poll result",
          error: null,
        };
      },
    };

    toolCtx = {
      client: mockClient,
      identity: myIdentity,
      pendingReplies,
      inboundContextManager: {
        getCurrentInbound: () => currentInbound,
        setCurrentInbound: (ctx) => {
          currentInbound = ctx;
        },
        getInbound: (id) => inboundQueue.get(id),
        removeInbound: (id) => {
          inboundQueue.delete(id);
        },
      },
      maxHops: 5,
    };
  });

  // ━━ ULID Generator Tests ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it("should generate 26-char Crockford Base32 ULIDs", () => {
    const id1 = generateUlid();
    const id2 = generateUlid();
    assert.equal(id1.length, 26);
    assert.equal(id2.length, 26);
    assert.notEqual(id1, id2);

    for (const char of id1) {
      assert.ok(CROCKFORD_ALPHABET.includes(char), `Invalid ULID char: ${char}`);
    }
  });

  it("should abbreviate model IDs and format peer rosters", () => {
    assert.equal(abbreviateModel("claude-3-5-sonnet"), "3-5-sonnet");
    assert.equal(abbreviateModel("claude-instant-1"), "instant-1");

    const peers: AgentCard[] = [
      {
        session_id: "1",
        name: "test-peer",
        purpose: "tester",
        model: "claude-3-5-sonnet",
        color: "#fff",
        cwd: "/",
        project: "default",
        explicit: false,
        started_at: "now",
        context_used_pct: 12,
        queue_depth: 0,
        status: "online",
      },
    ];
    const roster = formatPeerRoster(peers);
    assert.ok(roster.includes("● test-peer (3-5-sonnet) 12% — tester"));
  });

  // ━━ coms_net_list Tests ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it("should filter caller session from coms_net_list", async () => {
    const tools = new ComsNetTools(toolCtx);
    const res = await tools.list();
    assert.equal(res.details.agents.length, 2);
    // Verified caller session not present
    for (const a of res.details.agents) {
      assert.notEqual(a.session_id, myIdentity.session_id);
    }
    assert.ok(res.content[0].text.includes("2 peer(s):"));
    assert.ok(res.content[0].text.includes("● peer-agent"));
    assert.ok(res.content[0].text.includes("~ stale-peer"));
  });

  // ━━ coms_net_send & Hop Limit Tests ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it("should send message with hops=0 when no current inbound context", async () => {
    const tools = new ComsNetTools(toolCtx);
    const res = await tools.send({
      target: "peer-agent",
      prompt: "Hello!",
    });
    assert.equal(res.details.hops, 0);
    assert.equal(res.details.msg_id, "01J7SRVMSG0000000000000001");
    // Verify tracked in pendingReplies
    assert.ok(pendingReplies.has("01J7SRVMSG0000000000000001"));
  });

  it("should increment hops based on current inbound context", async () => {
    currentInbound = {
      msg_id: "inbound-msg-1",
      hops: 2,
      sender_session: "01J7SENDER000000000000001",
      sender_name: "delegator",
      sender_cwd: "/cwd",
      prompt: "please delegate",
      fulfilled: false,
    };

    const tools = new ComsNetTools(toolCtx);
    const res = await tools.send({
      target: "peer-agent",
      prompt: "Forwarded subtask",
    });
    assert.equal(res.details.hops, 3);
  });

  it("should reject message if hops >= 5 with HopLimitExceededError", async () => {
    currentInbound = {
      msg_id: "inbound-msg-loop",
      hops: 4, // Next hop will be 4 + 1 = 5 >= 5 (rejection!)
      sender_session: "01J7SENDER000000000000001",
      sender_name: "looper",
      sender_cwd: "/cwd",
      prompt: "loop",
      fulfilled: false,
    };

    const tools = new ComsNetTools(toolCtx);
    await assert.rejects(
      async () =>
        tools.send({
          target: "peer-agent",
          prompt: "infinite loop attempt",
        }),
      (err: unknown) => {
        assert.ok(err instanceof HopLimitExceededError);
        assert.equal((err as HopLimitExceededError).hops, 5);
        return true;
      }
    );
  });

  it("should reject message if explicit hops parameter is >= 5", async () => {
    const tools = new ComsNetTools(toolCtx);
    await assert.rejects(
      async () =>
        tools.send({
          target: "peer-agent",
          prompt: "test",
          hops: 5,
        }),
      (err: unknown) => {
        assert.ok(err instanceof HopLimitExceededError);
        return true;
      }
    );
  });

  // ━━ coms_net_get Cache & Fallback Tests ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it("should return fast-path result from pendingReplies without network call", async () => {
    pendingReplies.set("msg-fast", {
      resolve: () => {},
      reject: () => {},
      promise: Promise.resolve({ response: "instant response" }),
      result: { response: "instant response", error: null },
      created_at: new Date().toISOString(),
    });

    let networkCalled = false;
    toolCtx.client.getMessage = async () => {
      networkCalled = true;
      throw new Error("Should not be called");
    };

    const tools = new ComsNetTools(toolCtx);
    const res = await tools.get({ msg_id: "msg-fast" });
    assert.equal(networkCalled, false);
    assert.equal(res.details.status, "complete");
    assert.equal(res.details.response, "instant response");
  });

  it("should fallback to HTTP GET on cache miss and cache the result", async () => {
    const tools = new ComsNetTools(toolCtx);
    const res = await tools.get({ msg_id: "msg-remote" });
    assert.equal(res.details.status, "complete");
    assert.equal(res.details.response, "Remote result");
  });

  it("should handle 404 message not found gracefully in coms_net_get", async () => {
    const tools = new ComsNetTools(toolCtx);
    const res = await tools.get({ msg_id: "unknown-id" });
    assert.equal(res.details.status, "error");
    assert.equal(res.details.error, "unknown msg_id");
    assert.ok(res.content[0].text.includes("unknown msg_id unknown-id"));
  });

  // ━━ coms_net_await 3-Way Race Tests ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it("should resolve immediately when pendingReplies already has result", async () => {
    pendingReplies.set("msg-cached", {
      resolve: () => {},
      reject: () => {},
      promise: Promise.resolve({ response: "cached await" }),
      result: { response: "cached await", error: null },
      created_at: new Date().toISOString(),
    });

    const tools = new ComsNetTools(toolCtx);
    const res = await tools.await({ msg_id: "msg-cached" });
    assert.equal(res.details.status, "complete");
    assert.equal(res.details.response, "cached await");
  });

  it("should resolve via local SSE promise when it arrives first and abort HTTP long-poll", async () => {
    let httpAborted = false;
    toolCtx.client.awaitMessage = async (id, tm, signalOrOpts) => {
      const signal = signalOrOpts instanceof AbortSignal ? signalOrOpts : (signalOrOpts as any)?.signal;
      signal?.addEventListener("abort", () => {
        httpAborted = true;
      });
      // Simulate long-poll waiting longer than SSE
      return new Promise((resolve) => setTimeout(resolve, 500)) as any;
    };

    const tools = new ComsNetTools(toolCtx);
    const awaitPromise = tools.await({ msg_id: "msg-race-sse", timeout_ms: 1000 });

    // Simulate SSE pushing response after 20ms
    setTimeout(() => {
      const pending = pendingReplies.get("msg-race-sse");
      assert.ok(pending, "pending entry should exist");
      pending.resolve({ response: "SSE victory!", error: null });
    }, 20);

    const res = await awaitPromise;
    assert.equal(res.details.status, "complete");
    assert.equal(res.details.response, "SSE victory!");
    // Immediate abort check
    assert.equal(httpAborted, true, "HTTP await request should have been aborted immediately");
  });

  it("should resolve via server long-poll HTTP promise when it arrives first", async () => {
    toolCtx.client.awaitMessage = async (id, tm, signal) => {
      return {
        msg_id: id,
        status: "complete",
        response: "HTTP victory!",
        error: null,
      };
    };

    const tools = new ComsNetTools(toolCtx);
    const res = await tools.await({ msg_id: "msg-race-http", timeout_ms: 500 });
    assert.equal(res.details.status, "complete");
    assert.equal(res.details.response, "HTTP victory!");
  });

  it("should resolve with timeout status when timeout expires", async () => {
    let httpAborted = false;
    toolCtx.client.awaitMessage = async (id, tm, signalOrOpts) => {
      const signal = signalOrOpts instanceof AbortSignal ? signalOrOpts : (signalOrOpts as any)?.signal;
      signal?.addEventListener("abort", () => {
        httpAborted = true;
      });
      return new Promise(() => {}); // Never resolves
    };

    const tools = new ComsNetTools(toolCtx);
    const res = await tools.await({ msg_id: "msg-timeout", timeout_ms: 30 });
    assert.equal(res.details.status, "timeout");
    assert.equal(res.details.error, "timeout");
    assert.equal(httpAborted, true, "HTTP request should be aborted on timeout");
  });
});
