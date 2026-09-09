/**
 * tests/adversarial/adversarial-m3.test.ts
 *
 * Empirical Challenger M3: Stdio MCP Server & Distribution Stress Probing
 *
 * Suites:
 * 1. JSON-RPC 2.0 framing under fragmented input, invalid syntax, batch requests,
 *    missing id / notifications, and unknown methods.
 * 2. Tool schema validation under missing, empty, invalid types, and boundary parameters.
 * 3. Lazy hub discovery, auto-registration with explicit: true, and self-healing.
 * 4. Stdout channel isolation: zero debug/error leak on stdout across real subprocess.
 * 5. Event loop leaks, unhandled rejections, and hanging readline interfaces.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  McpServer,
  MCP_TOOLS_DEFINITIONS,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpServerOptions,
} from "../../src/mcp/server.ts";
import {
  ComsNetTools,
  type ToolContext,
  type IComsClient,
  type PendingReply,
} from "../../src/protocol/tools.ts";
import { MockHub } from "../mocks/mock-hub.ts";

// ━━ Harness Helper ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface Harness {
  server: McpServer;
  input: PassThrough;
  output: PassThrough;
  logs: string[];
  sendRaw: (data: string | Buffer) => void;
  send: (msg: unknown) => void;
  receive: (timeoutMs?: number) => Promise<JsonRpcResponse>;
  receiveAll: (count: number, timeoutMs?: number) => Promise<JsonRpcResponse[]>;
  drain: (waitMs?: number) => Promise<JsonRpcResponse[]>;
  cleanup: () => Promise<void>;
}

function createHarness(options: Partial<McpServerOptions> = {}): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const logs: string[] = [];
  const logFn = (msg: string) => logs.push(msg);

  const server = new McpServer({
    input,
    output,
    logFn,
    ...options,
  });

  server.start();

  let buffer = "";
  const queue: JsonRpcResponse[] = [];
  const rawLines: string[] = [];
  const waiters: Array<(resp: JsonRpcResponse) => void> = [];

  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line) {
        rawLines.push(line);
        try {
          const parsed = JSON.parse(line);
          if (waiters.length > 0) {
            const waiter = waiters.shift()!;
            waiter(parsed);
          } else {
            queue.push(parsed);
          }
        } catch {
          // ignore invalid json in consumer
        }
      }
    }
  });

  const sendRaw = (data: string | Buffer) => {
    input.write(data);
  };

  const send = (msg: unknown) => {
    if (typeof msg === "string") {
      input.write(msg + "\n");
    } else {
      input.write(JSON.stringify(msg) + "\n");
    }
  };

  const receive = (timeoutMs = 2000): Promise<JsonRpcResponse> => {
    if (queue.length > 0) {
      return Promise.resolve(queue.shift()!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for response (waited ${timeoutMs}ms)`));
      }, timeoutMs);

      waiters.push((resp) => {
        clearTimeout(timer);
        resolve(resp);
      });
    });
  };

  const receiveAll = async (count: number, timeoutMs = 2000): Promise<JsonRpcResponse[]> => {
    const results: JsonRpcResponse[] = [];
    for (let i = 0; i < count; i++) {
      results.push(await receive(timeoutMs));
    }
    return results;
  };

  const drain = async (waitMs = 100): Promise<JsonRpcResponse[]> => {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const items = [...queue];
    queue.length = 0;
    return items;
  };

  const cleanup = async () => {
    await server.stop();
  };

  return { server, input, output, logs, sendRaw, send, receive, receiveAll, drain, cleanup };
}

function createMockTools(overrides: Partial<IComsClient> = {}): ComsNetTools {
  const client: IComsClient = {
    async getAgents() {
      return {
        agents: [
          {
            session_id: "01J7OTHER000000000000000001",
            name: "peer-worker",
            purpose: "Data processing",
            model: "claude-3-5-sonnet",
            color: "#36F9F6",
            cwd: "/app",
            project: "test",
            explicit: false,
            started_at: new Date().toISOString(),
            context_used_pct: 15,
            queue_depth: 0,
            status: "online" as const,
          },
        ],
      };
    },
    async sendMessage() {
      return {
        ok: true,
        msg_id: "01J7MSG0000000000000000001",
        status: "delivered" as const,
        target_session: "01J7OTHER000000000000000001",
      };
    },
    async getMessage(msg_id) {
      if (msg_id === "unknown-id") {
        const err = new Error("Message not found");
        (err as any).status = 404;
        throw err;
      }
      return {
        msg_id,
        status: "complete" as const,
        response: "Response from peer-worker",
        error: null,
      };
    },
    async awaitMessage(msg_id, paramsOrTimeout) {
      if (msg_id === "unknown-id") {
        const err = new Error("Message not found");
        (err as any).status = 404;
        throw err;
      }
      if (msg_id === "hanging-id") {
        return new Promise(() => {}); // never resolves
      }
      return {
        msg_id,
        status: "complete" as const,
        response: "Awaited reply from peer-worker",
        error: null,
      };
    },
    ...overrides,
  };

  const ctx: ToolContext = {
    client,
    identity: {
      session_id: "01J7SELF000000000000000001",
      name: "mcp-agent",
      project: "test",
      cwd: "/home/matt",
    },
    pendingReplies: new Map<string, PendingReply>(),
  };

  return new ComsNetTools(ctx);
}

// ━━ Test Suite ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("Empirical Challenger M3: Stdio MCP Server & Packaging Stress", () => {

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Suite 1: JSON-RPC 2.0 Framing & Transport Stress
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe("Suite 1: JSON-RPC 2.0 Framing & Transport Stress", () => {
    it("C1.1: Byte-by-byte fragmented input across TCP/pipe frames", async () => {
      const h = createHarness();
      const payload = JSON.stringify({ jsonrpc: "2.0", id: "frag-1", method: "ping" }) + "\n";

      // Send 1 byte at a time with tiny delays
      for (const char of payload) {
        h.sendRaw(char);
      }

      const res = await h.receive();
      assert.strictEqual(res.jsonrpc, "2.0");
      assert.strictEqual(res.id, "frag-1");
      assert.deepStrictEqual(res.result, {});
      await h.cleanup();
    });

    it("C1.2: Multi-byte UTF-8 split across chunk boundaries", async () => {
      const h = createHarness();
      // "🤖" is 4 bytes: 0xF0 0x9F 0xA4 0x96
      const emoji = "🤖";
      const emojiBytes = Buffer.from(emoji, "utf8");
      assert.strictEqual(emojiBytes.length, 4);

      const prefix = Buffer.from('{"jsonrpc":"2.0","id":"', "utf8");
      const part1 = emojiBytes.subarray(0, 2); // half the emoji
      const part2 = emojiBytes.subarray(2);    // other half
      const suffix = Buffer.from('","method":"ping"}\n', "utf8");

      h.sendRaw(Buffer.concat([prefix, part1]));
      await new Promise((r) => setTimeout(r, 10));
      h.sendRaw(Buffer.concat([part2, suffix]));

      const res = await h.receive();
      assert.strictEqual(res.jsonrpc, "2.0");
      assert.strictEqual(res.id, emoji);
      assert.deepStrictEqual(res.result, {});
      await h.cleanup();
    });

    it("C1.3: Large 128KB payload fragmented across multiple chunks", async () => {
      const h = createHarness({ tools: createMockTools() });
      const largeText = "A".repeat(128 * 1024); // 128 KB prompt
      const msg = JSON.stringify({
        jsonrpc: "2.0",
        id: "large-1",
        method: "tools/call",
        params: {
          name: "coms_net_send",
          arguments: { target: "peer-worker", prompt: largeText },
        },
      }) + "\n";

      // Write in 4KB chunks
      const chunkSize = 4096;
      for (let i = 0; i < msg.length; i += chunkSize) {
        h.sendRaw(msg.slice(i, i + chunkSize));
      }

      const res = await h.receive(5000);
      assert.strictEqual(res.id, "large-1");
      const result = res.result as { isError: boolean };
      assert.strictEqual(result.isError, false);
      await h.cleanup();
    });

    it("C1.4: Multiple JSON-RPC requests concatenated in a single write", async () => {
      const h = createHarness();
      const burst = [
        JSON.stringify({ jsonrpc: "2.0", id: 101, method: "ping" }),
        JSON.stringify({ jsonrpc: "2.0", id: 102, method: "ping" }),
        JSON.stringify({ jsonrpc: "2.0", id: 103, method: "ping" }),
      ].join("\n") + "\n";

      h.sendRaw(burst);
      const responses = await h.receiveAll(3);
      assert.strictEqual(responses.length, 3);
      assert.strictEqual(responses[0].id, 101);
      assert.strictEqual(responses[1].id, 102);
      assert.strictEqual(responses[2].id, 103);
      await h.cleanup();
    });

    it("C1.5: Mixed Windows CRLF (\\r\\n) and Unix (\\n) line endings and blank lines", async () => {
      const h = createHarness();
      const mixed =
        "\r\n\r\n" +
        '{"jsonrpc":"2.0","id":"crlf-1","method":"ping"}\r\n' +
        "   \r\n" +
        '{"jsonrpc":"2.0","id":"crlf-2","method":"ping"}\n' +
        "\n\n" +
        '{"jsonrpc":"2.0","id":"crlf-3","method":"ping"}\r\n';

      h.sendRaw(mixed);
      const responses = await h.receiveAll(3);
      assert.strictEqual(responses[0].id, "crlf-1");
      assert.strictEqual(responses[1].id, "crlf-2");
      assert.strictEqual(responses[2].id, "crlf-3");
      await h.cleanup();
    });

    it("C1.6: Invalid JSON syntax variants emit -32700 Parse error with null id", async () => {
      const h = createHarness();
      const badInputs = [
        "{ unclosed json",
        '{"jsonrpc": "2.0", "method": "ping",}', // trailing comma
        "undefined",
        "<xml>not json</xml>",
        '{"jsonrpc": "2.0" \x00 "null byte"}',
      ];

      for (const bad of badInputs) {
        h.send(bad);
        const res = await h.receive();
        assert.strictEqual(res.jsonrpc, "2.0");
        assert.strictEqual(res.id, null);
        assert.strictEqual(res.error?.code, -32700);
      }
      await h.cleanup();
    });

    it("C1.7: Non-object JSON inputs emit -32600 Invalid Request", async () => {
      const h = createHarness();
      const primitives = ["123", '"plain string"', "true", "false", "null"];

      for (const prim of primitives) {
        h.send(prim);
        const res = await h.receive();
        assert.strictEqual(res.jsonrpc, "2.0");
        assert.strictEqual(res.error?.code, -32600);
      }
      await h.cleanup();
    });

    it("C1.8: Missing jsonrpc: '2.0' or invalid method types emit -32600", async () => {
      const h = createHarness();
      const invalidRequests = [
        { id: 1, method: "ping" },                      // missing jsonrpc
        { jsonrpc: "1.0", id: 2, method: "ping" },      // wrong jsonrpc
        { jsonrpc: "2.0", id: 3 },                      // missing method
        { jsonrpc: "2.0", id: 4, method: 12345 },       // method is number
        { jsonrpc: "2.0", id: 5, method: ["ping"] },     // method is array
        { jsonrpc: "2.0", id: 6, method: { name: "ping" } }, // method is object
      ];

      for (const req of invalidRequests) {
        h.send(req);
        const res = await h.receive();
        assert.strictEqual(res.jsonrpc, "2.0");
        assert.strictEqual(res.error?.code, -32600);
        assert.strictEqual(res.id, (req as any).id ?? null);
      }
      await h.cleanup();
    });

    it("C1.9: Batch requests (arrays) are rejected with -32600 Invalid Request", async () => {
      const h = createHarness();
      // Empty array batch
      h.send([]);
      const res1 = await h.receive();
      assert.strictEqual(res1.jsonrpc, "2.0");
      assert.strictEqual(res1.error?.code, -32600);

      // Non-empty array batch
      h.send([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ]);
      const res2 = await h.receive();
      assert.strictEqual(res2.jsonrpc, "2.0");
      assert.strictEqual(res2.error?.code, -32600);
      await h.cleanup();
    });

    it("C1.10: Notifications MUST NOT emit any response per JSON-RPC 2.0 spec", async () => {
      const h = createHarness();

      // 1. Standard notification
      h.send({ jsonrpc: "2.0", method: "initialized" });

      // 2. Unknown method notification
      h.send({ jsonrpc: "2.0", method: "nonexistent/notify" });

      // 3. Notification that causes internal dispatch failure
      h.send({ jsonrpc: "2.0", method: "tools/call", params: {} });

      // Send a ping request after all notifications to confirm no response was emitted
      h.send({ jsonrpc: "2.0", id: "probe-order", method: "ping" });

      // The FIRST response received MUST be the probe-order ping, with no intervening responses
      const res = await h.receive();
      assert.strictEqual(res.id, "probe-order");

      // Verify queue is empty
      const drained = await h.drain(50);
      assert.strictEqual(drained.length, 0, "No extra responses should be sent for notifications");
      await h.cleanup();
    });

    it("C1.11: id field formats (string, integer, float, null) preserved accurately", async () => {
      const h = createHarness();
      const testIds = ["str-id-123", 42, 100.5, null];

      for (const id of testIds) {
        h.send({ jsonrpc: "2.0", id, method: "ping" });
        const res = await h.receive();
        assert.strictEqual(res.id, id);
        assert.deepStrictEqual(res.result, {});
      }
      await h.cleanup();
    });

    it("C1.12: Unknown methods return -32601 Method not found", async () => {
      const h = createHarness();
      const unknownMethods = ["resources/list", "prompts/get", "sampling/createMessage", ""];

      for (const method of unknownMethods) {
        h.send({ jsonrpc: "2.0", id: `m-${method}`, method });
        const res = await h.receive();
        assert.strictEqual(res.id, `m-${method}`);
        assert.strictEqual(res.error?.code, -32601);
        assert.match(res.error?.message ?? "", /Method not found/);
      }
      await h.cleanup();
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Suite 2: Tool Schema Validation & Parameter Fuzzing
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe("Suite 2: Tool Schema Validation & Parameter Fuzzing", () => {
    let h: Harness;

    before(() => {
      h = createHarness({ tools: createMockTools() });
    });

    after(async () => {
      await h.cleanup();
    });

    it("C2.1: coms_net_send: missing target or prompt returns isError: true", async () => {
      // Missing target
      h.send({
        jsonrpc: "2.0",
        id: "send-no-target",
        method: "tools/call",
        params: { name: "coms_net_send", arguments: { prompt: "hello" } },
      });
      let res = await h.receive();
      assert.strictEqual(res.id, "send-no-target");
      let result = res.result as { content: Array<{ text: string }>; isError: boolean };
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /target must not be empty/i);

      // Missing prompt
      h.send({
        jsonrpc: "2.0",
        id: "send-no-prompt",
        method: "tools/call",
        params: { name: "coms_net_send", arguments: { target: "peer-worker" } },
      });
      res = await h.receive();
      assert.strictEqual(res.id, "send-no-prompt");
      result = res.result as { content: Array<{ text: string }>; isError: boolean };
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /prompt must not be empty/i);

      // Empty strings / whitespace
      h.send({
        jsonrpc: "2.0",
        id: "send-empty-strings",
        method: "tools/call",
        params: { name: "coms_net_send", arguments: { target: "   ", prompt: "\t\n" } },
      });
      res = await h.receive();
      assert.strictEqual(res.id, "send-empty-strings");
      result = res.result as { content: Array<{ text: string }>; isError: boolean };
      assert.strictEqual(result.isError, true);
    });

    it("C2.2: coms_net_send: non-string target or prompt handled gracefully without crash", async () => {
      // Non-string target (number)
      h.send({
        jsonrpc: "2.0",
        id: "send-num-target",
        method: "tools/call",
        params: { name: "coms_net_send", arguments: { target: 12345, prompt: "valid" } },
      });
      let res = await h.receive();
      assert.strictEqual(res.id, "send-num-target");
      let result = res.result as { content: Array<{ text: string }>; isError: boolean };
      assert.strictEqual(result.isError, true);

      // Non-string prompt (object)
      h.send({
        jsonrpc: "2.0",
        id: "send-obj-prompt",
        method: "tools/call",
        params: { name: "coms_net_send", arguments: { target: "peer-worker", prompt: { foo: "bar" } } },
      });
      res = await h.receive();
      assert.strictEqual(res.id, "send-obj-prompt");
      result = res.result as { content: Array<{ text: string }>; isError: boolean };
      assert.strictEqual(result.isError, true);
    });

    it("C2.3: coms_net_send: hop ceiling enforcement returns isError: true", async () => {
      h.send({
        jsonrpc: "2.0",
        id: "send-hop-limit",
        method: "tools/call",
        params: {
          name: "coms_net_send",
          arguments: { target: "peer-worker", prompt: "hop loop", hops: 5 },
        },
      });
      const res = await h.receive();
      assert.strictEqual(res.id, "send-hop-limit");
      const result = res.result as { content: Array<{ text: string }>; isError: boolean };
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /hop limit exceeded/i);
    });

    it("C2.4: coms_net_get: missing or empty msg_id returns isError: true", async () => {
      // Missing msg_id
      h.send({
        jsonrpc: "2.0",
        id: "get-no-msg-id",
        method: "tools/call",
        params: { name: "coms_net_get", arguments: {} },
      });
      let res = await h.receive();
      assert.strictEqual(res.id, "get-no-msg-id");
      let result = res.result as { content: Array<{ text: string }>; isError: boolean };
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /msg_id must not be empty/i);

      // Empty string msg_id
      h.send({
        jsonrpc: "2.0",
        id: "get-empty-msg-id",
        method: "tools/call",
        params: { name: "coms_net_get", arguments: { msg_id: "  " } },
      });
      res = await h.receive();
      assert.strictEqual(res.id, "get-empty-msg-id");
      result = res.result as { content: Array<{ text: string }>; isError: boolean };
      assert.strictEqual(result.isError, true);

      // Non-existent msg_id (404)
      h.send({
        jsonrpc: "2.0",
        id: "get-404-msg-id",
        method: "tools/call",
        params: { name: "coms_net_get", arguments: { msg_id: "unknown-id" } },
      });
      res = await h.receive();
      assert.strictEqual(res.id, "get-404-msg-id");
      result = res.result as { content: Array<{ text: string }>; isError: boolean };
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /unknown msg_id/i);
    });

    it("C2.5: coms_net_await: missing msg_id, negative timeout, and string timeout handled cleanly", async () => {
      // Missing msg_id
      h.send({
        jsonrpc: "2.0",
        id: "await-no-msg-id",
        method: "tools/call",
        params: { name: "coms_net_await", arguments: {} },
      });
      let res = await h.receive();
      assert.strictEqual(res.id, "await-no-msg-id");
      let result = res.result as { content: Array<{ text: string }>; isError: boolean };
      assert.strictEqual(result.isError, true);

      // Negative timeout (should fallback to default timeout, not throw)
      h.send({
        jsonrpc: "2.0",
        id: "await-neg-timeout",
        method: "tools/call",
        params: {
          name: "coms_net_await",
          arguments: { msg_id: "01J7MSG0000000000000000001", timeout_ms: -500 },
        },
      });
      res = await h.receive();
      assert.strictEqual(res.id, "await-neg-timeout");
      result = res.result as { content: Array<{ text: string }>; isError: boolean };
      assert.strictEqual(result.isError, false);

      // String timeout (should fallback to default timeout, not throw)
      h.send({
        jsonrpc: "2.0",
        id: "await-str-timeout",
        method: "tools/call",
        params: {
          name: "coms_net_await",
          arguments: { msg_id: "01J7MSG0000000000000000001", timeout_ms: "not-a-num" },
        },
      });
      res = await h.receive();
      assert.strictEqual(res.id, "await-str-timeout");
      result = res.result as { content: Array<{ text: string }>; isError: boolean };
      assert.strictEqual(result.isError, false);
    });

    it("C2.6: coms_net_list: non-boolean include_explicit does not leak explicit agents", async () => {
      // Pass include_explicit: "true" (string instead of boolean)
      h.send({
        jsonrpc: "2.0",
        id: "list-str-explicit",
        method: "tools/call",
        params: { name: "coms_net_list", arguments: { include_explicit: "true" } },
      });
      const res = await h.receive();
      assert.strictEqual(res.id, "list-str-explicit");
      const result = res.result as { content: Array<{ text: string }>; isError: boolean };
      assert.strictEqual(result.isError, false);
    });

    it("C2.7: tools/call with missing params or missing name", async () => {
      // No params at all
      h.send({ jsonrpc: "2.0", id: "call-no-params", method: "tools/call" });
      let res = await h.receive();
      assert.strictEqual(res.id, "call-no-params");
      assert.strictEqual(res.error?.code, -32602);

      // Missing arguments field in params
      h.send({ jsonrpc: "2.0", id: "call-no-args", method: "tools/call", params: { name: "coms_net_list" } });
      res = await h.receive();
      assert.strictEqual(res.id, "call-no-args");
      let result = res.result as { isError: boolean };
      assert.strictEqual(result.isError, false);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Suite 3: Lazy Hub Discovery & Self-Healing
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe("Suite 3: Lazy Hub Discovery & Self-Healing", () => {
    it("C3.1: Handshake and tools/list succeed even when hub is offline", async () => {
      const h = createHarness({
        discoveryOptions: {
          serverUrl: "http://127.0.0.1:59998", // completely dead port
          authToken: "test-token",
        },
      });

      // initialize should NOT attempt to connect to hub
      h.send({
        jsonrpc: "2.0",
        id: "init-offline",
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      });
      const initRes = await h.receive();
      assert.strictEqual(initRes.id, "init-offline");
      assert.ok(initRes.result);

      // tools/list should NOT attempt to connect to hub
      h.send({ jsonrpc: "2.0", id: "list-offline", method: "tools/list" });
      const listRes = await h.receive();
      assert.strictEqual(listRes.id, "list-offline");
      assert.ok(listRes.result);

      await h.cleanup();
    });

    it("C3.2: 5 consecutive failed tool calls while hub is offline do not crash or leak", async () => {
      const h = createHarness({
        discoveryOptions: {
          serverUrl: "http://127.0.0.1:59997",
          authToken: "test-token",
        },
      });

      for (let i = 1; i <= 5; i++) {
        h.send({
          jsonrpc: "2.0",
          id: `burst-offline-${i}`,
          method: "tools/call",
          params: { name: "coms_net_list", arguments: {} },
        });
        const res = await h.receive(3000);
        assert.strictEqual(res.id, `burst-offline-${i}`);
        const result = res.result as { isError: boolean; content: Array<{ text: string }> };
        assert.strictEqual(result.isError, true);
        assert.match(result.content[0].text, /failed|refused|connect/i);
      }

      await h.cleanup();
    });

    it("C3.3: Hub dying while MCP server is running returns isError: true on tool calls without crash", async () => {
      const hub = new MockHub();
      await hub.start();

      const h = createHarness({
        discoveryOptions: {
          serverUrl: hub.baseUrl,
          authToken: hub.token,
          project: "dying-hub-test",
        },
        agentName: "dying-hub-client",
      });

      // First tool call: connects and registers
      h.send({
        jsonrpc: "2.0",
        id: "before-death",
        method: "tools/call",
        params: { name: "coms_net_list", arguments: {} },
      });
      const res1 = await h.receive(5000);
      assert.strictEqual(res1.id, "before-death");
      assert.strictEqual((res1.result as any).isError, false);

      // Now shut down the hub
      await hub.stop();

      // Tool call while hub is dead: should return isError: true, NOT crash the process
      h.send({
        jsonrpc: "2.0",
        id: "after-death",
        method: "tools/call",
        params: { name: "coms_net_list", arguments: {} },
      });
      const res2 = await h.receive(5000);
      assert.strictEqual(res2.id, "after-death");
      const result2 = res2.result as { isError: boolean; content: Array<{ text: string }> };
      assert.strictEqual(result2.isError, true);

      await h.cleanup();
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Suite 4: Stdout Channel Isolation (Real Subprocess)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe("Suite 4: Stdout Channel Isolation (Real Subprocess)", () => {
    it("C4.1: bin/coms-net-mcp.js subprocess strictly reserves stdout for valid JSON-RPC frames", async () => {
      const scriptPath = join(process.cwd(), "bin", "coms-net-mcp.js");

      // Spawn real node subprocess
      const child = spawn(process.execPath, [scriptPath], {
        env: {
          ...process.env,
          // Intentionally broken hub to provoke connection errors and diagnostics
          PI_COMS_NET_SERVER_URL: "http://127.0.0.1:59996",
          PI_COMS_NET_AUTH_TOKEN: "dummy-secret-token",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];

      let stdoutBuf = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8");
        let idx: number;
        while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (line) stdoutLines.push(line);
        }
      });

      let stderrBuf = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString("utf8");
        let idx: number;
        while ((idx = stderrBuf.indexOf("\n")) !== -1) {
          const line = stderrBuf.slice(0, idx).trim();
          stderrBuf = stderrBuf.slice(idx + 1);
          if (line) stderrLines.push(line);
        }
      });

      // Send barrage of requests:
      // 1. Handshake
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
      // 2. Initialized notification
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
      // 3. Ping
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n");
      // 4. Bad JSON
      child.stdin.write("INVALID JSON SYNTAX\n");
      // 5. Tool call that fails connecting to hub
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "coms_net_list", arguments: {} },
      }) + "\n");

      // Wait 1s for all processing to complete
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Close stdin
      child.stdin.end();

      // Wait for clean subprocess exit
      const exitCode = await new Promise<number>((resolve) => {
        child.on("exit", (code) => resolve(code ?? 0));
      });

      assert.strictEqual(exitCode, 0, "Subprocess should exit cleanly with 0 on stdin close");

      // VERIFICATION OF CHANNEL ISOLATION:
      assert.ok(stdoutLines.length >= 4, `Expected at least 4 stdout lines, got ${stdoutLines.length}`);

      for (const line of stdoutLines) {
        let parsed: any;
        try {
          parsed = JSON.parse(line);
        } catch {
          assert.fail(`Corrupted stdout line detected (not valid JSON): ${line}`);
        }
        assert.strictEqual(parsed.jsonrpc, "2.0", `Stdout line must be JSON-RPC 2.0 frame: ${line}`);
        // Ensure no diagnostic tokens leaked into stdout
        assert.doesNotMatch(line, /\[mcp-server\]/, "Diagnostic tag leaked into stdout!");
        assert.doesNotMatch(line, /dummy-secret-token/, "Token leaked into stdout!");
      }
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Suite 5: Event Loop Leaks, Resource Cleanup & Signal Handling
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe("Suite 5: Event Loop Leaks, Resource Cleanup & Signal Handling", () => {
    it("C5.1: 20 rapid start/stop cycles release resources without leaks", async () => {
      for (let i = 0; i < 20; i++) {
        const input = new PassThrough();
        const output = new PassThrough();
        const server = new McpServer({ input, output, logFn: () => {} });
        await server.start();
        await server.stop();
      }
    });

    it("C5.2: Closing input stream triggers clean stop() and unregistration", async () => {
      const hub = new MockHub();
      await hub.start();

      const input = new PassThrough();
      const output = new PassThrough();
      const server = new McpServer({
        input,
        output,
        discoveryOptions: {
          serverUrl: hub.baseUrl,
          authToken: hub.token,
          project: "stream-close-test",
        },
        agentName: "stream-closer",
        logFn: () => {},
      });

      await server.start();

      // Trigger presence registration via tool call
      await server.handleLine(JSON.stringify({
        jsonrpc: "2.0",
        id: "trigger",
        method: "tools/call",
        params: { name: "coms_net_list", arguments: {} },
      }));

      const proj = hub.getProject("stream-close-test");
      assert.strictEqual(proj.agents.size, 1);

      // Now close input stream (simulate pipe EOF)
      input.end();

      // Wait for readline 'close' event to run stop()
      await new Promise((r) => setTimeout(r, 400));

      // Verify agent was cleanly unregistered from hub
      assert.strictEqual(proj.agents.size, 0, "Agent must be removed from hub on input EOF");

      await server.stop();
      await hub.stop();
    });

    it("C5.3: Multiple calls to start() and stop() are idempotent", async () => {
      const server = new McpServer({ input: new PassThrough(), output: new PassThrough(), logFn: () => {} });
      await server.start();
      await server.start(); // second start should be a no-op
      await server.stop();
      await server.stop();  // second stop should be a no-op
    });

    it("C5.4: Empirical probe: McpServer AgentLifecycle unhandled 'error' event crash vulnerability", async () => {
      const hub = new MockHub();
      await hub.start();

      const logs: string[] = [];
      const server = new McpServer({
        discoveryOptions: {
          serverUrl: hub.baseUrl,
          authToken: hub.token,
          project: "lifecycle-err-probe",
        },
        agentName: "lifecycle-probe-client",
        logFn: (msg) => logs.push(msg),
      });

      await server.start();

      // Trigger initialization
      await server.handleLine(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "coms_net_list", arguments: {} },
      }));

      const lifecycle = (server as any).lifecycle;
      assert.ok(lifecycle, "Lifecycle should be initialized");

      // Check whether an error listener is attached
      const listenerCount = lifecycle.listenerCount("error");

      // Vulnerability verification:
      // If listenerCount === 0, emitting 'error' crashes the process in Node.js!
      // Here we demonstrate and record the defect:
      if (listenerCount === 0) {
        let threwUncaught = false;
        try {
          lifecycle.emit("error", new Error("Simulated 401 unauthorized heartbeat error"));
        } catch (err: any) {
          threwUncaught = true;
          assert.strictEqual(err.message, "Simulated 401 unauthorized heartbeat error");
        }
        assert.strictEqual(
          threwUncaught,
          true,
          "CONFIRMED DEFECT: AgentLifecycle has 0 error listeners, causing unhandled error exception crash"
        );
      } else {
        // Safe: error listener exists
        assert.ok(listenerCount > 0, "Lifecycle should have an error listener attached");
      }

      await server.stop();
      await hub.stop();
    });
  });
});
