/**
 * tests/unit/sse.test.ts
 *
 * Comprehensive unit and integration tests for SseParser and SseEventListener.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { MockHub } from "../mocks/mock-hub.ts";
import { SseParser, SseEventListener } from "../../src/bridge/sse.ts";

describe("SseParser Pure Chunk Decoder Unit Tests", () => {
  it("P1: should parse standard single SSE frame with event, id, and JSON data", () => {
    const events: Array<{ event: string; data: any; id?: string }> = [];
    const parser = new SseParser((event, data, id) => {
      events.push({ event, data, id });
    });

    const payload = Buffer.from(
      'event: hello\nid: 101\ndata: {"server_time":"2026-09-09T00:00:00Z","server_id":"srv-1"}\n\n'
    );
    parser.feed(payload);

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, "hello");
    assert.strictEqual(events[0].id, "101");
    assert.strictEqual(events[0].data.server_id, "srv-1");
    assert.strictEqual(events[0].data.server_time, "2026-09-09T00:00:00Z");
  });

  it("P2: should join multi-line data fields with newline", () => {
    const events: Array<{ event: string; data: any }> = [];
    const parser = new SseParser((event, data) => {
      events.push({ event, data });
    });

    const payload = Buffer.from("event: custom\ndata: first line\ndata: second line\n\n");
    parser.feed(payload);

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, "custom");
    assert.strictEqual(events[0].data, "first line\nsecond line");
  });

  it("P3: should handle TCP chunk fragmentation across boundaries", () => {
    const events: Array<{ event: string; data: any }> = [];
    const parser = new SseParser((event, data) => {
      events.push({ event, data });
    });

    const chunk1 = Buffer.from("event: pro");
    const chunk2 = Buffer.from('mpt\ndata: {"te');
    const chunk3 = Buffer.from('xt":"hello fragmented world"}\n\n');

    parser.feed(chunk1);
    assert.strictEqual(events.length, 0);

    parser.feed(chunk2);
    assert.strictEqual(events.length, 0);

    parser.feed(chunk3);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, "prompt");
    assert.strictEqual(events[0].data.text, "hello fragmented world");
  });

  it("P4: should decode multi-byte UTF-8 sequences fractured across chunk boundaries", () => {
    const events: Array<{ event: string; data: any }> = [];
    const parser = new SseParser((event, data) => {
      events.push({ event, data });
    });

    // 4-byte UTF-8 emoji 🎉: 0xF0 0x9F 0x8E 0x89
    const prefix = Buffer.from('event: message\ndata: {"emoji":"');
    const fractured1 = Buffer.from([0xf0, 0x9f]);
    const fractured2 = Buffer.from([0x8e, 0x89]);
    const suffix = Buffer.from('"}\n\n');

    parser.feed(Buffer.concat([prefix, fractured1]));
    assert.strictEqual(events.length, 0);

    parser.feed(Buffer.concat([fractured2, suffix]));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].data.emoji, "🎉");
    assert.ok(!JSON.stringify(events[0].data).includes("\uFFFD"));
  });

  it("P5: should parse multiple SSE frames inside a single chunk", () => {
    const events: Array<{ event: string; data: any }> = [];
    const parser = new SseParser((event, data) => {
      events.push({ event, data });
    });

    const chunk = Buffer.from(
      'event: frame1\ndata: {"val":1}\n\nevent: frame2\ndata: {"val":2}\n\n'
    );
    parser.feed(chunk);

    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].event, "frame1");
    assert.strictEqual(events[0].data.val, 1);
    assert.strictEqual(events[1].event, "frame2");
    assert.strictEqual(events[1].data.val, 2);
  });

  it("P6: should dispatch keepalive comment lines and not treat them as events", () => {
    const events: Array<{ event: string; data: any }> = [];
    const comments: string[] = [];

    const parser = new SseParser(
      (event, data) => events.push({ event, data }),
      (comment) => comments.push(comment)
    );

    const chunk = Buffer.from(": ping 2026-09-09T06:00:00.000Z\n\n");
    parser.feed(chunk);

    assert.strictEqual(events.length, 0, "No events should be emitted for comment");
    assert.strictEqual(comments.length, 1);
    assert.strictEqual(comments[0], "ping 2026-09-09T06:00:00.000Z");
  });

  it("P7: should preserve raw string when data is not valid JSON", () => {
    const events: Array<{ event: string; data: any }> = [];
    const parser = new SseParser((event, data) => {
      events.push({ event, data });
    });

    const chunk = Buffer.from("data: {unquoted_broken_json\n\n");
    parser.feed(chunk);

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].data, "{unquoted_broken_json");
  });

  it("P8: should normalize CRLF to LF correctly", () => {
    const events: Array<{ event: string; data: any }> = [];
    const parser = new SseParser((event, data) => {
      events.push({ event, data });
    });

    const chunk = Buffer.from("event: crlf\r\ndata: ok\r\n\r\n");
    parser.feed(chunk);

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, "crlf");
    assert.strictEqual(events[0].data, "ok");
  });
});

describe("SseEventListener Reconnection & MockHub Integration Tests", () => {
  let hub: MockHub;

  before(async () => {
    hub = new MockHub();
    await hub.start();
  });

  after(async () => {
    await hub.stop();
  });

  it("L1: should connect to MockHub and receive initial hello and pool_snapshot", async () => {
    // Register agent on hub first
    const p = hub.getProject("default");
    const sid = "01JMSSETEST000000000000001";
    p.agents.set(sid, {
      session_id: sid,
      name: "sse-receiver",
      project: "default",
      purpose: "SSE testing",
      model: "gemini-2.5-pro",
      color: "#36F9F6",
      cwd: process.cwd(),
      explicit: false,
      started_at: new Date().toISOString(),
      registered_at: new Date().toISOString(),
      last_seen_at: Date.now(),
      status: "online",
      context_used_pct: 0,
      queue_depth: 0,
    });

    const listener = new SseEventListener({
      baseUrl: hub.baseUrl,
      authToken: hub.token,
      project: "default",
      sessionId: sid,
    });

    let helloReceived = false;
    let snapshotReceived = false;

    listener.on("hello", (data) => {
      assert.ok(data.server_time);
      assert.ok(data.server_id);
      helloReceived = true;
    });

    listener.on("pool_snapshot", (data) => {
      assert.strictEqual(data.project, "default");
      assert.ok(Array.isArray(data.agents));
      snapshotReceived = true;
    });

    await listener.start();

    // Wait briefly for handshake frames
    for (let i = 0; i < 20; i++) {
      if (helloReceived && snapshotReceived) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.strictEqual(helloReceived, true, "hello event must be received");
    assert.strictEqual(snapshotReceived, true, "pool_snapshot event must be received");
    assert.strictEqual(listener.getState(), "connected");

    await listener.stop();
    assert.strictEqual(listener.getState(), "closed");
  });

  it("L2: should receive inbound prompt and parse keepalive pings", async () => {
    const p = hub.getProject("default");
    const sid = "01JMSSETEST000000000000002";
    p.agents.set(sid, {
      session_id: sid,
      name: "sse-worker",
      project: "default",
      purpose: "SSE worker testing",
      model: "gemini-2.5-pro",
      color: "#72F1B8",
      cwd: process.cwd(),
      explicit: false,
      started_at: new Date().toISOString(),
      registered_at: new Date().toISOString(),
      last_seen_at: Date.now(),
      status: "online",
      context_used_pct: 0,
      queue_depth: 0,
    });

    const listener = new SseEventListener({
      baseUrl: hub.baseUrl,
      authToken: hub.token,
      project: "default",
      sessionId: sid,
    });

    let receivedPrompt: any = null;
    let receivedPing: string | null = null;

    listener.on("prompt", (prompt) => {
      receivedPrompt = prompt;
    });

    listener.on("ping", (ts) => {
      receivedPing = ts;
    });

    await listener.start();
    await new Promise((r) => setTimeout(r, 50));

    // Emit a keepalive comment from hub
    hub.emitKeepalive();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(receivedPing, "Ping timestamp must be received");
    assert.ok(typeof listener.getLastPingAt() === "number");

    // Push an inbound prompt from hub
    const msgId = "01JMSSEMSG000000000000001";
    p.messages.set(msgId, {
      msg_id: msgId,
      project: "default",
      sender_session: "sender-1",
      target_session: sid,
      prompt: "Execute task alpha",
      conversation_id: "conv-1",
      response_schema: null,
      hops: 0,
      status: "delivered",
      response: null,
      error: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      expires_at: Date.now() + 60000,
    });

    (hub as any).sendToStream(p, sid, "prompt", {
      msg_id: msgId,
      project: "default",
      sender: { session_id: "sender-1", name: "sender-agent", cwd: "/tmp" },
      prompt: "Execute task alpha",
      conversation_id: "conv-1",
      response_schema: null,
      hops: 0,
    });

    for (let i = 0; i < 20; i++) {
      if (receivedPrompt) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(receivedPrompt);
    assert.strictEqual(receivedPrompt.msg_id, msgId);
    assert.strictEqual(receivedPrompt.prompt, "Execute task alpha");

    await listener.stop();
  });

  it("L3: should execute pre-reconnect register callback and backoff reconnection on disconnect", async () => {
    let registerCount = 0;
    let reconnectAttemptsRecorded: number[] = [];

    // Custom mock fetch that fails initially to test backoff progression
    let fetchAttempts = 0;
    const mockFetch = async () => {
      fetchAttempts++;
      return new Response("Not Found", { status: 404 });
    };

    const listener = new SseEventListener({
      baseUrl: "http://127.0.0.1:9090",
      project: "default",
      sessionId: "01JMTESTRECONNECT000000001",
      reconnectBaseMs: 10,
      reconnectMaxMs: 50,
      fetchFn: mockFetch as any,
      registerFn: async () => {
        registerCount++;
        return {
          ok: true,
          agent: {} as any,
          heartbeat_interval_ms: 10000,
          sse_url: "/v1/events",
        };
      },
    });

    listener.on("reconnect_scheduled", (attempt) => {
      reconnectAttemptsRecorded.push(attempt);
    });

    await listener.start();

    // Wait for a few backoff ticks
    await new Promise((r) => setTimeout(r, 120));

    assert.ok(registerCount >= 1, "registerFn must be called before reconnecting");
    assert.ok(reconnectAttemptsRecorded.length >= 1, "reconnect_scheduled should fire");

    await listener.stop();
    assert.strictEqual(listener.getState(), "closed");
  });
});
