/**
 * tests/adversarial/sse-resilience-stress.test.ts
 *
 * Empirical Challenger Test Suite for Milestone M2:
 * 1. Extreme chunk fragmentation & streaming stress in SseParser
 *    - 1 byte per chunk fragmentation
 *    - Exact \n\n and \r\n\r\n boundary splits
 *    - Multi-byte UTF-8 character splitting
 *    - Mixed CRLF and LF framing
 *    - Corrupted data lines and missing fields
 *    - Keepalive : ping <timestamp> comment handling
 * 2. Reconnection resilience & socket lifecycle in SseEventListener
 *    - Abrupt server socket termination
 *    - Exponential backoff sequence (500ms, 1000ms, 2000ms... up to 10s ceiling)
 *    - Pre-reconnect agent re-registration on hub restart
 *    - Resource cleanup: reader cancellation, timer clearance, zero socket leaks
 *    - Non-recoverable auth failure (401) handling
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { SseParser, SseEventListener } from "../../src/bridge/sse.ts";
import { MockHub } from "../mocks/mock-hub.ts";

describe("Challenger M2: SseParser Extreme Streaming Stress", () => {
  it("C1.1: should handle extreme 1-byte-per-chunk fragmentation across multiple frames", () => {
    const events: Array<{ event: string; data: unknown; id?: string }> = [];
    const comments: string[] = [];

    const parser = new SseParser(
      (event, data, id) => events.push({ event, data, id }),
      (comment) => comments.push(comment)
    );

    const frames = [];
    for (let i = 0; i < 20; i++) {
      frames.push(
        `: ping 2026-09-09T06:${String(i).padStart(2, "0")}:00.000Z\n` +
        `event: evt_${i}\n` +
        `id: id_${i}\n` +
        `data: {"idx":${i},"text":"Fragmented test 🎉 🚀 世界 ${i}"}\n\n`
      );
    }
    const fullStream = Buffer.from(frames.join(""), "utf-8");

    for (let i = 0; i < fullStream.length; i++) {
      parser.feed(fullStream.subarray(i, i + 1));
    }
    parser.flush();

    assert.strictEqual(comments.length, 20, "Should have received all 20 ping comments");
    assert.strictEqual(events.length, 20, "Should have received all 20 events");

    for (let i = 0; i < 20; i++) {
      assert.strictEqual(events[i].event, `evt_${i}`);
      assert.strictEqual(events[i].id, `id_${i}`);
      assert.strictEqual((events[i].data as any).idx, i);
      assert.strictEqual((events[i].data as any).text, `Fragmented test 🎉 🚀 世界 ${i}`);
    }
  });

  it("C1.2: should correctly parse frames split exactly across newline boundaries", () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const parser = new SseParser((event, data) => events.push({ event, data }));

    const chunk1 = Buffer.from("event: split_lf\ndata: payload_1\n");
    const chunk2 = Buffer.from("\nevent: split_crlf\r\ndata: payload_2\r\n\r");
    const chunk3 = Buffer.from("\n");

    parser.feed(chunk1);
    assert.strictEqual(events.length, 0, "No event before boundary completed");

    parser.feed(chunk2);
    assert.strictEqual(events.length, 1, "First frame should complete");
    assert.strictEqual(events[0].event, "split_lf");
    assert.strictEqual(events[0].data, "payload_1");

    parser.feed(chunk3);
    assert.strictEqual(events.length, 2, "Second frame should complete");
    assert.strictEqual(events[1].event, "split_crlf");
    assert.strictEqual(events[1].data, "payload_2");
  });

  it("C1.3: should handle multi-byte UTF-8 sequences fractured at every byte offset", () => {
    const testStrings = [
      "Café",
      "日本語テスト",
      "🔥🚀🧠🎉",
      "👨‍👩‍👦",
    ];

    for (const str of testStrings) {
      const payload = Buffer.from(
        `event: unicode\ndata: {"content":"${str}"}\n\n`,
        "utf-8"
      );

      for (let split = 1; split < payload.length; split++) {
        const events: Array<{ event: string; data: any }> = [];
        const parser = new SseParser((event, data) => events.push({ event, data }));

        parser.feed(payload.subarray(0, split));
        parser.feed(payload.subarray(split));

        assert.strictEqual(events.length, 1, `Failed at split ${split} for ${str}`);
        assert.strictEqual(events[0].data.content, str, `Corrupted content at split ${split}`);
        assert.ok(
          !JSON.stringify(events[0].data).includes("\uFFFD"),
          `Contains replacement char at split ${split}`
        );
      }
    }
  });

  it("C1.4: should process streams with mixed CRLF and LF framing in arbitrary order", () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const parser = new SseParser((event, data) => events.push({ event, data }));

    const mixedPayload = Buffer.from(
      "event: frame_lf\ndata: line 1\n\n" +
      "event: frame_crlf\r\ndata: line 2\r\n\r\n" +
      "event: frame_mixed_lines\r\ndata: line A\ndata: line B\r\n\r\n" +
      "event: frame_crlf_with_lf_term\r\ndata: line 3\n\n"
    );

    parser.feed(mixedPayload);

    assert.strictEqual(events.length, 4);
    assert.strictEqual(events[0].event, "frame_lf");
    assert.strictEqual(events[0].data, "line 1");

    assert.strictEqual(events[1].event, "frame_crlf");
    assert.strictEqual(events[1].data, "line 2");

    assert.strictEqual(events[2].event, "frame_mixed_lines");
    assert.strictEqual(events[2].data, "line A\nline B");

    assert.strictEqual(events[3].event, "frame_crlf_with_lf_term");
    assert.strictEqual(events[3].data, "line 3");
  });

  it("C1.5: should gracefully preserve raw string for corrupted or invalid JSON lines", () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const parser = new SseParser((event, data) => events.push({ event, data }));

    const brokenCases = [
      'data: {unclosed object\n\n',
      'data: [1, 2, 3,\n\n',
      'data: undefined\n\n',
      'data: 12345\n\n',
      'data: true\n\n',
      'data: null\n\n',
      'data: "already quoted string"\n\n',
      'data: raw plain text without formatting\n\n',
    ];

    for (const c of brokenCases) {
      parser.feed(Buffer.from(c));
    }

    assert.strictEqual(events.length, brokenCases.length);
    assert.strictEqual(events[0].data, "{unclosed object");
    assert.strictEqual(events[1].data, "[1, 2, 3,");
    assert.strictEqual(events[2].data, "undefined");
    assert.strictEqual(events[3].data, 12345);
    assert.strictEqual(events[4].data, true);
    assert.strictEqual(events[5].data, null);
    assert.strictEqual(events[6].data, "already quoted string");
    assert.strictEqual(events[7].data, "raw plain text without formatting");
  });

  it("C1.6: should conform to WHATWG SSE specification for missing fields", () => {
    const events: Array<{ event: string; data: unknown; id?: string }> = [];
    const parser = new SseParser((event, data, id) => events.push({ event, data, id }));

    // 1. Frame with no event name -> defaults to "message"
    parser.feed(Buffer.from('data: {"msg":"default event"}\n\n'));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, "message");

    // 2. Frame with no id -> id remains undefined
    assert.strictEqual(events[0].id, undefined);

    // 3. Frame with no data field -> per WHATWG spec, must NOT dispatch event
    parser.feed(Buffer.from("event: only_event\nid: 999\n\n"));
    assert.strictEqual(events.length, 1, "Must discard event without data");

    // 4. Multiple event names in same frame -> last one wins
    parser.feed(Buffer.from("event: first\nevent: second\ndata: ok\n\n"));
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[1].event, "second");

    // 5. Unknown fields safely ignored
    parser.feed(Buffer.from("event: custom\nretry: 3000\nunknown_field: 42\ndata: ok2\n\n"));
    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[2].event, "custom");
    assert.strictEqual(events[2].data, "ok2");
  });

  it("C1.7: should handle keepalive : ping comments with varied whitespace and inline placement", () => {
    const events: Array<{ event: string; data: unknown }> = [];
    const comments: string[] = [];

    const parser = new SseParser(
      (event, data) => events.push({ event, data }),
      (comment) => comments.push(comment)
    );

    const stream = Buffer.from(
      ": ping 2026-09-09T06:00:00.000Z\n\n" +
      ":ping 2026-09-09T06:01:00.000Z\n\n" +
      ":   ping   2026-09-09T06:02:00.000Z   \n\n" +
      ": general non-ping comment\n\n" +
      ": ping 2026-09-09T06:03:00.000Z\n" +
      "event: prompt\n" +
      "data: {\"task\":\"execute\"}\n\n"
    );

    parser.feed(stream);

    assert.strictEqual(comments.length, 5);
    assert.strictEqual(comments[0], "ping 2026-09-09T06:00:00.000Z");
    assert.strictEqual(comments[1], "ping 2026-09-09T06:01:00.000Z");
    assert.strictEqual(comments[2], "ping   2026-09-09T06:02:00.000Z");
    assert.strictEqual(comments[3], "general non-ping comment");
    assert.strictEqual(comments[4], "ping 2026-09-09T06:03:00.000Z");

    assert.strictEqual(events.length, 1, "Only 1 event emitted from the prompt frame");
    assert.strictEqual(events[0].event, "prompt");
  });

  it("C1.8: should accurately parse high-volume randomized chunk stream (fuzzing chunk boundaries)", () => {
    const events: Array<{ event: string; data: any; id?: string }> = [];
    const parser = new SseParser((event, data, id) => events.push({ event, data, id }));

    // Generate 100 frames with varying field orders and multi-byte content
    const frames: string[] = [];
    for (let i = 0; i < 100; i++) {
      frames.push(
        `id: ${i}\n` +
        `event: fuzz_${i % 5}\n` +
        `data: {"seq":${i},"payload":"data_fuzz_💎_${i}","nested":{"flag":${i % 2 === 0}}}\n\n`
      );
    }
    const fullBuffer = Buffer.from(frames.join(""), "utf-8");

    // Feed in pseudo-random chunk sizes between 1 and 17 bytes
    let offset = 0;
    let step = 3;
    while (offset < fullBuffer.length) {
      const chunkSize = Math.min(fullBuffer.length - offset, (step % 17) + 1);
      parser.feed(fullBuffer.subarray(offset, offset + chunkSize));
      offset += chunkSize;
      step = (step * 7 + 1) % 100;
    }
    parser.flush();

    assert.strictEqual(events.length, 100, "Must parse all 100 fuzzed frames");
    for (let i = 0; i < 100; i++) {
      assert.strictEqual(events[i].id, String(i));
      assert.strictEqual(events[i].event, `fuzz_${i % 5}`);
      assert.strictEqual(events[i].data.seq, i);
      assert.strictEqual(events[i].data.payload, `data_fuzz_💎_${i}`);
    }
  });

  it("C1.9: should handle massive 1MB payload without truncation or memory issues", () => {
    const events: Array<{ event: string; data: any }> = [];
    const parser = new SseParser((event, data) => events.push({ event, data }));

    // Construct ~1MB JSON payload
    const largeObject: Record<string, string> = {};
    for (let i = 0; i < 5000; i++) {
      largeObject[`key_${i}`] = `value_long_string_for_payload_testing_${i}_🚀`;
    }
    const jsonString = JSON.stringify(largeObject);
    const frame = Buffer.from(`event: big_payload\ndata: ${jsonString}\n\n`, "utf-8");

    // Feed in 32KB chunks
    const chunkSize = 32 * 1024;
    for (let offset = 0; offset < frame.length; offset += chunkSize) {
      parser.feed(frame.subarray(offset, Math.min(frame.length, offset + chunkSize)));
    }
    parser.flush();

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event, "big_payload");
    assert.strictEqual(Object.keys(events[0].data).length, 5000);
    assert.strictEqual(events[0].data.key_4999, "value_long_string_for_payload_testing_4999_🚀");
  });
});

describe("Challenger M2: SseEventListener Reconnection & Resilience", () => {
  let testServer: http.Server;
  let testPort: number;
  let activeSockets: Set<import("node:net").Socket> = new Set();

  before(async () => {
    testServer = http.createServer((req, res) => {
      const socket = req.socket;
      activeSockets.add(socket);
      socket.on("close", () => activeSockets.delete(socket));

      const parsedUrl = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (parsedUrl.pathname === "/v1/events") {
        const projectParam = parsedUrl.searchParams.get("project") ?? "";
        if (projectParam === "unauthorized") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
          return;
        }

        if (projectParam === "not_found") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "agent_not_found" }));
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });

        res.write("event: hello\ndata: {\"server_id\":\"test-hub\"}\n\n");
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      testServer.listen(0, "127.0.0.1", () => {
        const addr = testServer.address() as { port: number };
        testPort = addr.port;
        resolve();
      });
    });
  });

  after(async () => {
    for (const sock of activeSockets) {
      sock.destroy();
    }
    activeSockets.clear();
    testServer.closeAllConnections();
    await new Promise<void>((resolve) => testServer.close(() => resolve()));
  });

  it("C2.1: should detect abrupt server socket destruction and transition to reconnecting", async () => {
    let capturedSocket: import("node:net").Socket | null = null;
    const socketServer = http.createServer((req, res) => {
      capturedSocket = req.socket;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write("event: hello\ndata: {}\n\n");
    });

    await new Promise<void>((resolve) => socketServer.listen(0, "127.0.0.1", resolve));
    const sPort = (socketServer.address() as { port: number }).port;

    const listener = new SseEventListener({
      baseUrl: `http://127.0.0.1:${sPort}`,
      sessionId: "ABRUPT-TEST",
      reconnectBaseMs: 50,
      reconnectMaxMs: 200,
    });

    try {
      let disconnectedReason: string | null = null;
      listener.on("disconnected", (reason) => {
        disconnectedReason = reason;
      });

      await listener.start();
      assert.strictEqual(listener.getState(), "connected");
      assert.ok(capturedSocket);

      (capturedSocket as import("node:net").Socket).destroy();

      for (let i = 0; i < 30; i++) {
        if (listener.getState() === "reconnecting") break;
        await new Promise((r) => setTimeout(r, 20));
      }

      assert.strictEqual(listener.getState(), "reconnecting");
      assert.strictEqual(disconnectedReason, "stream_error");
    } finally {
      await listener.stop();
      assert.strictEqual(listener.getState(), "closed");
      await new Promise<void>((r) => socketServer.close(() => r()));
    }
  });

  it("C2.2: should calculate exact exponential backoff progression up to ceiling", () => {
    const listener = new SseEventListener({
      baseUrl: `http://127.0.0.1:${testPort}`,
      sessionId: "BACKOFF-TEST",
      reconnectBaseMs: 500,
      reconnectMaxMs: 10_000,
    });

    const sequence: Array<{ attempt: number; delayMs: number }> = [];
    let capReached = false;

    listener.on("reconnect_scheduled", (attempt, delayMs) => {
      sequence.push({ attempt, delayMs });
    });

    listener.on("reconnect_cap_reached", () => {
      capReached = true;
    });

    for (let i = 0; i < 7; i++) {
      (listener as any).scheduleReconnect();
      if ((listener as any).reconnectTimer) {
        clearTimeout((listener as any).reconnectTimer);
        (listener as any).reconnectTimer = null;
      }
    }

    assert.deepStrictEqual(sequence, [
      { attempt: 1, delayMs: 500 },
      { attempt: 2, delayMs: 1000 },
      { attempt: 3, delayMs: 2000 },
      { attempt: 4, delayMs: 4000 },
      { attempt: 5, delayMs: 8000 },
      { attempt: 6, delayMs: 10000 },
      { attempt: 7, delayMs: 10000 },
    ]);

    assert.strictEqual(capReached, true, "reconnect_cap_reached must be emitted");
  });

  it("C2.3: should re-register agent on hub restart before reconnecting", async () => {
    const hub = new MockHub();
    await hub.start();

    const sid = "01JMCHALLENGERESTART00001";
    let registerCount = 0;

    const registerAgent = async () => {
      registerCount++;
      const p = hub.getProject("default");
      p.agents.set(sid, {
        session_id: sid,
        name: "restart-agent",
        project: "default",
        purpose: "restart test",
        model: "test",
        color: "#FEDE5D",
        cwd: "/tmp",
        explicit: false,
        started_at: new Date().toISOString(),
        registered_at: new Date().toISOString(),
        last_seen_at: Date.now(),
        status: "online",
        context_used_pct: 0,
        queue_depth: 0,
      });
      return {
        ok: true,
        agent: p.agents.get(sid) as any,
        heartbeat_interval_ms: 10000,
        sse_url: `/v1/events?session_id=${sid}`,
      };
    };

    await registerAgent();

    const listener = new SseEventListener({
      baseUrl: hub.baseUrl,
      authToken: hub.token,
      project: "default",
      sessionId: sid,
      reconnectBaseMs: 50,
      reconnectMaxMs: 200,
      registerFn: registerAgent,
    });

    try {
      let helloCount = 0;
      listener.on("hello", () => helloCount++);

      await listener.start();
      assert.strictEqual(listener.getState(), "connected");

      // Simulate hub restart
      const p = hub.getProject("default");
      for (const client of p.streams.values()) {
        client.res.socket?.destroy();
      }
      p.streams.clear();
      p.agents.clear();

      for (let i = 0; i < 40; i++) {
        if (helloCount >= 2 && listener.getState() === "connected") break;
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.ok(registerCount >= 2, "registerFn must have run to re-register on wiped hub");
      assert.ok(p.agents.has(sid), "Agent must be present in hub registry after reconnect");
      assert.strictEqual(listener.getState(), "connected");
      assert.ok(helloCount >= 2, "Must receive hello from reconnected stream");
    } finally {
      await listener.stop();
      await hub.stop();
    }
  });

  it("C2.4: should cancel stream reader, abort controllers, and clear timers on stop()", async () => {
    const listener = new SseEventListener({
      baseUrl: `http://127.0.0.1:${testPort}`,
      sessionId: "CLEANUP-TEST",
      reconnectBaseMs: 50,
      reconnectMaxMs: 100,
    });

    await listener.start();
    await new Promise((r) => setTimeout(r, 50));

    assert.ok((listener as any).activeReader !== null, "activeReader must be present while streaming");
    assert.ok((listener as any).activeAbortController !== null, "AbortController must be present");

    await listener.stop();

    assert.strictEqual((listener as any).activeReader, null, "activeReader must be null after stop");
    assert.strictEqual((listener as any).activeAbortController, null, "activeAbortController must be null after stop");
    assert.strictEqual((listener as any).reconnectTimer, null, "reconnectTimer must be null after stop");
    assert.strictEqual(listener.getState(), "closed");
  });

  it("C2.5: should leak 0 sockets across multiple sequential open/stop cycles", async () => {
    const initialSockets = activeSockets.size;

    for (let i = 0; i < 15; i++) {
      const listener = new SseEventListener({
        baseUrl: `http://127.0.0.1:${testPort}`,
        sessionId: `LEAK-TEST-${i}`,
        reconnectBaseMs: 20,
        reconnectMaxMs: 50,
      });

      await listener.start();
      assert.strictEqual(listener.getState(), "connected");

      await listener.stop();
      assert.strictEqual(listener.getState(), "closed");
    }

    // Wait for underlying sockets to complete graceful TCP teardown
    for (let i = 0; i < 20; i++) {
      if (activeSockets.size === initialSockets) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.strictEqual(
      activeSockets.size,
      initialSockets,
      `Lingering socket leak detected: ${activeSockets.size} vs ${initialSockets}`
    );
  });

  it("C2.6: should terminate immediately on HTTP 401 Unauthorized without reconnect loops", async () => {
    const listener = new SseEventListener({
      baseUrl: `http://127.0.0.1:${testPort}`,
      sessionId: "AUTH-FAIL-TEST",
      reconnectBaseMs: 50,
      reconnectMaxMs: 100,
      project: "unauthorized",
    });

    try {
      let authFailed = false;
      let errorFired = false;
      listener.on("auth_failed", () => (authFailed = true));
      listener.on("error", () => (errorFired = true));

      await listener.start();

      assert.strictEqual(listener.getState(), "closed");
      assert.strictEqual(authFailed, true, "auth_failed must be emitted");
      assert.strictEqual(errorFired, true, "error must be emitted");
      assert.strictEqual((listener as any).reconnectTimer, null, "No reconnect timer on 401");
    } finally {
      await listener.stop();
    }
  });

  it("C2.7: should cancel pending reconnect timer when stopped during reconnecting state", async () => {
    let reRegisterRan = false;

    const listener = new SseEventListener({
      baseUrl: "http://127.0.0.1:59998",
      sessionId: "PENDING-TIMER-TEST",
      reconnectBaseMs: 100,
      reconnectMaxMs: 200,
      registerFn: async () => {
        reRegisterRan = true;
        return {} as any;
      },
    });

    try {
      await listener.start();
      assert.strictEqual(listener.getState(), "reconnecting");
      assert.ok((listener as any).reconnectTimer !== null);

      await listener.stop();
      assert.strictEqual(listener.getState(), "closed");
      assert.strictEqual((listener as any).reconnectTimer, null);

      await new Promise((r) => setTimeout(r, 150));
      assert.strictEqual(reRegisterRan, false, "registerFn must NOT execute after stop()");
    } finally {
      await listener.stop();
    }
  });

  it("C2.8: should guarantee idempotency on concurrent start() invocations", async () => {
    const listener = new SseEventListener({
      baseUrl: `http://127.0.0.1:${testPort}`,
      sessionId: "CONCURRENT-START-TEST",
      reconnectBaseMs: 50,
      reconnectMaxMs: 100,
    });

    try {
      // Fire 5 concurrent start calls
      await Promise.all([
        listener.start(),
        listener.start(),
        listener.start(),
        listener.start(),
        listener.start(),
      ]);

      assert.strictEqual(listener.getState(), "connected");
      assert.strictEqual(listener.getReconnectAttempts(), 0);
    } finally {
      await listener.stop();
    }
  });

  it("C2.9: should continue exponential backoff sequence if registerFn throws during reconnect", async () => {
    let registerAttempts = 0;
    const disconnectReasons: string[] = [];

    const listener = new SseEventListener({
      baseUrl: `http://127.0.0.1:${testPort}`,
      sessionId: "REGISTER-FAIL-BACKOFF-TEST",
      reconnectBaseMs: 20,
      reconnectMaxMs: 80,
      registerFn: async () => {
        registerAttempts++;
        throw new Error("Simulated hub registration network failure");
      },
    });

    listener.on("disconnected", (reason) => {
      disconnectReasons.push(reason);
    });

    try {
      // Intentionally trigger reconnect
      (listener as any).scheduleReconnect();

      // Wait for at least 2 backoff cycles with failing registerFn
      for (let i = 0; i < 20; i++) {
        if (registerAttempts >= 2) break;
        await new Promise((r) => setTimeout(r, 30));
      }

      assert.ok(registerAttempts >= 2, "registerFn should have been retried on backoff");
      assert.ok(
        disconnectReasons.includes("re_register_failed"),
        "Should record re_register_failed disconnect reason"
      );
      assert.ok(listener.getReconnectAttempts() >= 2, "Attempts counter should increment");
    } finally {
      await listener.stop();
    }
  });
});
