/**
 * tests/unit/mcp-server.test.ts
 *
 * In-memory unit tests for McpServer:
 * - JSON-RPC 2.0 stdio framing and lifecycle (initialize, ping, notifications/initialized)
 * - Error code standards (-32700 parse error, -32600 invalid request, -32601 method not found, -32602 invalid params)
 * - tools/list declarations and exact JSON schema verification
 * - tools/call execution routing for all 4 tools (list, send, get, await)
 * - Domain error handling and non-crashing behavior
 * - Lazy hub discovery, auto-recovery/self-healing, and stream teardown unregistration
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
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
import { HopLimitExceededError } from "../../src/protocol/errors.ts";
import { MockHub } from "../mocks/mock-hub.ts";

// ── In-Memory Stream Harness Helper ─────────────────────────────────────────

function createHarness(options: Partial<McpServerOptions> = {}) {
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
  const waiters: Array<(resp: JsonRpcResponse) => void> = [];

  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line) {
        try {
          const parsed = JSON.parse(line);
          if (waiters.length > 0) {
            const waiter = waiters.shift()!;
            waiter(parsed);
          } else {
            queue.push(parsed);
          }
        } catch {
          // Ignore invalid parse in test consumer
        }
      }
    }
  });

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

  const cleanup = async () => {
    await server.stop();
  };

  return { server, input, output, logs, send, receive, cleanup };
}

// ── Mock Tools Generator ───────────────────────────────────────────────────

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
    async sendMessage(params) {
      return {
        ok: true,
        msg_id: "01J7MSG0000000000000000001",
        status: "delivered" as const,
        target_session: "01J7OTHER000000000000000001",
      };
    },
    async getMessage(msg_id) {
      return {
        msg_id,
        status: "complete" as const,
        response: "Response from peer-worker",
        error: null,
      };
    },
    async awaitMessage(msg_id) {
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe("McpServer Stdio Unit Tests", () => {
  describe("JSON-RPC 2.0 Framing & Error Standards", () => {
    it("T1: should emit -32700 Parse error on invalid JSON string", async () => {
      const h = createHarness();
      h.send("not a valid json line");
      const res = await h.receive();
      assert.strictEqual(res.jsonrpc, "2.0");
      assert.strictEqual(res.id, null);
      assert.strictEqual(res.error?.code, -32700);
      assert.match(res.error?.message ?? "", /Parse error/i);
      await h.cleanup();
    });

    it("T2: should emit -32600 Invalid Request when payload is not valid JSON-RPC 2.0", async () => {
      const h = createHarness();
      h.send({ foo: "bar" });
      const res = await h.receive();
      assert.strictEqual(res.jsonrpc, "2.0");
      assert.strictEqual(res.error?.code, -32600);
      assert.match(res.error?.message ?? "", /Invalid Request/i);
      await h.cleanup();
    });

    it("T3: should emit -32601 Method not found for unsupported methods", async () => {
      const h = createHarness();
      h.send({ jsonrpc: "2.0", id: 101, method: "prompts/list" });
      const res = await h.receive();
      assert.strictEqual(res.jsonrpc, "2.0");
      assert.strictEqual(res.id, 101);
      assert.strictEqual(res.error?.code, -32601);
      assert.match(res.error?.message ?? "", /prompts\/list/);
      await h.cleanup();
    });

    it("T4: should handle initialize handshake with protocolVersion and serverInfo", async () => {
      const h = createHarness();
      h.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      });
      const res = await h.receive();
      assert.strictEqual(res.jsonrpc, "2.0");
      assert.strictEqual(res.id, 1);
      const result = res.result as {
        protocolVersion: string;
        capabilities: { tools: { listChanged: boolean } };
        serverInfo: { name: string; version: string };
      };
      assert.strictEqual(result.protocolVersion, "2024-11-05");
      assert.strictEqual(result.capabilities.tools.listChanged, false);
      assert.strictEqual(result.serverInfo.name, "antigravity-coms-net");
      assert.strictEqual(result.serverInfo.version, "0.1.0");
      await h.cleanup();
    });

    it("T5: should not emit response for notifications/initialized and initialized", async () => {
      const h = createHarness();
      h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      h.send({ jsonrpc: "2.0", method: "initialized" });

      // Follow up with a request to verify queue order and confirm no extra responses
      h.send({ jsonrpc: "2.0", id: 2, method: "ping" });
      const res = await h.receive();
      assert.strictEqual(res.id, 2);
      assert.deepStrictEqual(res.result, {});
      await h.cleanup();
    });

    it("T6: should return empty object for ping liveness check", async () => {
      const h = createHarness();
      h.send({ jsonrpc: "2.0", id: "ping-1", method: "ping" });
      const res = await h.receive();
      assert.strictEqual(res.id, "ping-1");
      assert.deepStrictEqual(res.result, {});
      await h.cleanup();
    });
  });

  describe("tools/list Declarations & JSON Schemas", () => {
    it("T7: should declare exactly the 4 required tools with proper descriptions", async () => {
      const h = createHarness();
      h.send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
      const res = await h.receive();
      assert.strictEqual(res.id, 3);
      const tools = (res.result as { tools: Array<{ name: string; description: string }> }).tools;
      assert.strictEqual(tools.length, 4);

      const names = tools.map((t) => t.name);
      assert.ok(names.includes("coms_net_list"));
      assert.ok(names.includes("coms_net_send"));
      assert.ok(names.includes("coms_net_get"));
      assert.ok(names.includes("coms_net_await"));
      await h.cleanup();
    });

    it("T8: should declare accurate JSON Schemas matching specification", async () => {
      const h = createHarness();
      h.send({ jsonrpc: "2.0", id: 4, method: "tools/list" });
      const res = await h.receive();
      const tools = (res.result as { tools: typeof MCP_TOOLS_DEFINITIONS }).tools;

      // coms_net_send schema
      const sendTool = tools.find((t) => t.name === "coms_net_send")!;
      assert.ok(sendTool.description.includes("DO NOT call this tool to REPLY"));
      assert.deepStrictEqual(sendTool.inputSchema.required, ["target", "prompt"]);
      assert.ok("target" in sendTool.inputSchema.properties);
      assert.ok("prompt" in sendTool.inputSchema.properties);
      assert.ok("conversation_id" in sendTool.inputSchema.properties);
      assert.ok("response_schema" in sendTool.inputSchema.properties);

      // coms_net_get schema
      const getTool = tools.find((t) => t.name === "coms_net_get")!;
      assert.deepStrictEqual(getTool.inputSchema.required, ["msg_id"]);
      assert.ok("msg_id" in getTool.inputSchema.properties);

      // coms_net_await schema
      const awaitTool = tools.find((t) => t.name === "coms_net_await")!;
      assert.deepStrictEqual(awaitTool.inputSchema.required, ["msg_id"]);
      assert.ok("msg_id" in awaitTool.inputSchema.properties);
      assert.ok("timeout_ms" in awaitTool.inputSchema.properties);

      // coms_net_list schema
      const listTool = tools.find((t) => t.name === "coms_net_list")!;
      assert.ok("project" in listTool.inputSchema.properties);
      assert.ok("include_explicit" in listTool.inputSchema.properties);
      await h.cleanup();
    });
  });

  describe("tools/call Execution Routing", () => {
    it("T9: should return -32602 when name parameter is missing in tools/call", async () => {
      const h = createHarness({ tools: createMockTools() });
      h.send({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { arguments: {} },
      });
      const res = await h.receive();
      assert.strictEqual(res.id, 5);
      assert.strictEqual(res.error?.code, -32602);
      assert.match(res.error?.message ?? "", /Missing required parameter 'name'/);
      await h.cleanup();
    });

    it("T10: should return isError: true when tool name is unknown", async () => {
      const h = createHarness({ tools: createMockTools() });
      h.send({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "non_existent_tool", arguments: {} },
      });
      const res = await h.receive();
      assert.strictEqual(res.id, 6);
      const result = res.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /Unknown tool 'non_existent_tool'/);
      await h.cleanup();
    });

    it("T11: should execute coms_net_list and return formatted peer list", async () => {
      const h = createHarness({ tools: createMockTools() });
      h.send({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "coms_net_list", arguments: {} },
      });
      const res = await h.receive();
      assert.strictEqual(res.id, 7);
      const result = res.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.strictEqual(result.isError, false);
      assert.match(result.content[0].text, /1 peer\(s\)/);
      assert.match(result.content[0].text, /peer-worker/);
      await h.cleanup();
    });

    it("T12: should execute coms_net_send and return msg_id", async () => {
      const h = createHarness({ tools: createMockTools() });
      h.send({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "coms_net_send",
          arguments: { target: "peer-worker", prompt: "Hello from test" },
        },
      });
      const res = await h.receive();
      assert.strictEqual(res.id, 8);
      const result = res.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.strictEqual(result.isError, false);
      assert.match(result.content[0].text, /coms_net_send → peer-worker/);
      assert.match(result.content[0].text, /01J7MSG0000000000000000001/);
      await h.cleanup();
    });

    it("T13: should execute coms_net_get and return response", async () => {
      const h = createHarness({ tools: createMockTools() });
      h.send({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "coms_net_get",
          arguments: { msg_id: "01J7MSG0000000000000000001" },
        },
      });
      const res = await h.receive();
      assert.strictEqual(res.id, 9);
      const result = res.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.strictEqual(result.isError, false);
      assert.match(result.content[0].text, /Response from peer-worker/);
      await h.cleanup();
    });

    it("T14: should execute coms_net_await and return awaited response", async () => {
      const h = createHarness({ tools: createMockTools() });
      h.send({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "coms_net_await",
          arguments: { msg_id: "01J7MSG0000000000000000001", timeout_ms: 5000 },
        },
      });
      const res = await h.receive();
      assert.strictEqual(res.id, 10);
      const result = res.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.strictEqual(result.isError, false);
      assert.match(result.content[0].text, /Awaited reply from peer-worker/);
      await h.cleanup();
    });

    it("T15: should handle tool domain error without process crash and return isError: true", async () => {
      const h = createHarness({
        tools: createMockTools({
          async sendMessage() {
            throw new HopLimitExceededError(409, "hop_limit_exceeded", { hops: 5, max_hops: 5 });
          },
        }),
      });
      h.send({
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "coms_net_send",
          arguments: { target: "loop-agent", prompt: "loop prompt" },
        },
      });
      const res = await h.receive();
      assert.strictEqual(res.id, 11);
      const result = res.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /hop limit exceeded/i);
      await h.cleanup();
    });
  });

  describe("Lazy Hub Discovery, Auto-Recovery & Lifecycle", () => {
    it("T16: should return isError: true with diagnostics when hub is offline", async () => {
      const h = createHarness({
        discoveryOptions: {
          serverUrl: "http://127.0.0.1:59999",
          authToken: "dummy-token",
        },
      });
      h.send({
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: { name: "coms_net_list", arguments: {} },
      });
      const res = await h.receive(5000);
      assert.strictEqual(res.id, 12);
      const result = res.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /Failed to register MCP client|ECONNREFUSED|discovery failed/i);
      await h.cleanup();
    });

    it("T17 & T18: should register agent on lazy connect, use explicit: true, and unregister on stream close", async () => {
      const hub = new MockHub();
      await hub.start();

      const h = createHarness({
        discoveryOptions: {
          serverUrl: hub.baseUrl,
          authToken: hub.token,
          project: "mcp-lifecycle-test",
        },
        agentName: "lazy-mcp-agent",
      });

      // Handshake first (does NOT trigger hub connect)
      h.send({ jsonrpc: "2.0", id: 20, method: "initialize", params: {} });
      const initRes = await h.receive();
      assert.strictEqual(initRes.id, 20);

      // Verify not yet registered in hub
      const projectBefore = hub.getProject("mcp-lifecycle-test");
      assert.strictEqual(projectBefore.agents.size, 0, "Agent should not register prior to first tool call");

      // First tool call: triggers lazy discovery and presence registration
      h.send({
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: { name: "coms_net_list", arguments: {} },
      });
      const listRes = await h.receive(5000);
      assert.strictEqual(listRes.id, 21);
      const listResult = listRes.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.strictEqual(listResult.isError, false);

      // Verify agent registered in hub with explicit: true
      assert.strictEqual(projectBefore.agents.size, 1, "Agent must be registered in hub after tool call");
      let foundSessionId = "";
      let foundAgent: any = null;
      for (const [id, agent] of projectBefore.agents.entries()) {
        foundSessionId = id;
        foundAgent = agent;
        break;
      }
      assert.ok(foundSessionId);
      assert.strictEqual(foundAgent.name, "lazy-mcp-agent");
      assert.strictEqual(foundAgent.explicit, true, "MCP client must be registered with explicit: true");

      // T18: Close input stream (simulate process/stream exit)
      h.input.end();

      // Wait a short time for cleanup unregistration to complete
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify agent was unregistered
      assert.strictEqual(projectBefore.agents.has(foundSessionId), false, "Agent must unregister on stream close");

      await h.cleanup();
      await hub.stop();
    });

    it("T19: should self-heal and connect when hub starts after initial failure", async () => {
      // Pick a dedicated port
      const hubPort = 44555;
      const hub = new MockHub({ port: hubPort, token: "heal-token" });

      const h = createHarness({
        discoveryOptions: {
          serverUrl: `http://127.0.0.1:${hubPort}`,
          authToken: "heal-token",
          project: "self-healing-test",
        },
        agentName: "self-healing-agent",
      });

      // 1. First call fails because hub is not running yet
      h.send({
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: { name: "coms_net_list", arguments: {} },
      });
      const failRes = await h.receive(5000);
      assert.strictEqual(failRes.id, 31);
      const failResult = failRes.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.strictEqual(failResult.isError, true);

      // 2. Hub starts up
      await hub.start();

      // 3. Second call retry succeeds
      h.send({
        jsonrpc: "2.0",
        id: 32,
        method: "tools/call",
        params: { name: "coms_net_list", arguments: {} },
      });
      const successRes = await h.receive(5000);
      assert.strictEqual(successRes.id, 32);
      const successResult = successRes.result as { content: Array<{ type: string; text: string }>; isError: boolean };
      assert.strictEqual(successResult.isError, false);

      // Verify agent presence in hub
      const project = hub.getProject("self-healing-test");
      assert.strictEqual(project.agents.size, 1);

      await h.cleanup();
      await hub.stop();
    });
  });
});
