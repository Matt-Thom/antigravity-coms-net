/**
 * src/mcp/server.ts
 *
 * Antigravity Model Context Protocol (MCP) Stdio Server.
 * Exposes coms_net_list, coms_net_send, coms_net_get, and coms_net_await
 * over JSON-RPC 2.0 stdio transport conforming to MCP 2024-11-05.
 */

import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { discoverHub } from "../protocol/discovery.ts";
import { ComsNetClient } from "../protocol/client.ts";
import { ComsNetTools, type PendingReply } from "../protocol/tools.ts";
import { AgentLifecycle } from "../bridge/lifecycle.ts";
import type {
  DiscoveryOptions,
  DiscoveryResult,
  ToolListParams,
  ToolSendParams,
  ToolGetParams,
  ToolAwaitParams,
} from "../protocol/types.ts";

// ── JSON-RPC 2.0 Protocol Types ─────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpCallToolResult {
  content: Array<{
    type: "text";
    text: string;
  }>;
  isError?: boolean;
}

export interface McpServerOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  client?: ComsNetClient;
  tools?: ComsNetTools;
  lifecycle?: AgentLifecycle;
  discoveryOptions?: DiscoveryOptions;
  agentName?: string;
  agentPurpose?: string;
  logFn?: (message: string) => void;
}

// ── Tool Definitions ────────────────────────────────────────────────────────

export const MCP_TOOLS_DEFINITIONS = [
  {
    name: "coms_net_list",
    description:
      "List peer agents on the coms-net hub for the current project. Returns names, models, and live context-window usage. Set include_explicit=true to reveal agents launched with --explicit.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "Optional project namespace. Defaults to caller's configured project.",
        },
        include_explicit: {
          type: "boolean",
          description: "Include hidden/explicit agents in the listing. Default is false.",
        },
      },
    },
  },
  {
    name: "coms_net_send",
    description:
      "INITIATE a new outbound message to a peer agent on the coms-net hub. Returns synchronously with a msg_id once the server queues the prompt. Use coms_net_get (non-blocking) or coms_net_await (blocking) with that msg_id to retrieve the peer's reply.\n\n" +
      "⚠️ DO NOT call this tool to REPLY to an inbound message. When answering an inbound message, write your answer as your normal assistant text — the coms-net bridge automatically captures it and submits it back. Calling coms_net_send to reply creates an infinite ping-pong loop.\n\n" +
      "Valid uses: (a) starting a new task/conversation with a peer; (b) delegating to a different peer than the one whose prompt you are answering.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "Peer agent name (preferred, scoped to project) or session_id (ULID).",
        },
        prompt: {
          type: "string",
          description: "The prompt or message text to deliver to the target agent.",
        },
        conversation_id: {
          type: "string",
          description: "Optional conversation ID for continuing a multi-turn dialogue.",
        },
        response_schema: {
          type: "object",
          description: "Optional JSON Schema specifying the expected structured output format.",
        },
      },
      required: ["target", "prompt"],
    },
  },
  {
    name: "coms_net_get",
    description:
      "Non-blocking poll of a reply to YOUR OWN outbound coms_net_send. Returns status (queued|delivered|complete|error|timeout) and (when complete) the response. Only use msg_ids returned by coms_net_send.",
    inputSchema: {
      type: "object",
      properties: {
        msg_id: {
          type: "string",
          description: "Message ID (ULID) returned by coms_net_send.",
        },
      },
      required: ["msg_id"],
    },
  },
  {
    name: "coms_net_await",
    description:
      "Block until the reply to YOUR OWN outbound coms_net_send arrives, or the timeout fires (default 30 min). Only call this with a msg_id that YOU received from coms_net_send.",
    inputSchema: {
      type: "object",
      properties: {
        msg_id: {
          type: "string",
          description: "Message ID (ULID) returned by coms_net_send.",
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds (defaults to 1,800,000 ms / 30 minutes).",
        },
      },
      required: ["msg_id"],
    },
  },
];

// ── MCP Server Implementation ───────────────────────────────────────────────

export class McpServer {
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly options: McpServerOptions;
  private readonly log: (msg: string) => void;

  private client: ComsNetClient | null = null;
  private tools: ComsNetTools | null = null;
  private lifecycle: AgentLifecycle | null = null;
  private readonly pendingReplies = new Map<string, PendingReply>();

  private rl: readline.Interface | null = null;
  private initialized = false;
  private isRunning = false;

  constructor(options: McpServerOptions = {}) {
    this.options = options;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.log = options.logFn ?? ((msg: string) => process.stderr.write(`[mcp-server] ${msg}\n`));

    // Preset dependencies (useful in unit testing)
    if (options.client) this.client = options.client;
    if (options.tools) this.tools = options.tools;
    if (options.lifecycle) this.lifecycle = options.lifecycle;
  }

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    this.rl = readline.createInterface({
      input: this.input as NodeJS.ReadableStream,
      terminal: false,
    });

    this.rl.on("line", (line: string) => {
      this.handleLine(line).catch((err) => {
        this.log(`Unhandled error handling line: ${err instanceof Error ? err.stack : String(err)}`);
      });
    });

    this.rl.on("close", () => {
      this.stop().catch((err) => {
        this.log(`Error during stream close stop: ${err}`);
      });
    });
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    if (this.lifecycle) {
      try {
        await this.lifecycle.stop();
      } catch (err) {
        this.log(`Error during lifecycle unregister: ${err}`);
      }
      this.lifecycle = null;
    }
    this.tools = null;
    this.client = null;
  }

  public async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.sendError(null, -32700, "Parse error: Invalid JSON");
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      this.sendError(null, -32600, "Invalid Request");
      return;
    }

    const req = parsed as JsonRpcRequest;
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      this.sendError(req.id ?? null, -32600, "Invalid Request: missing jsonrpc: '2.0' or method");
      return;
    }

    // Is notification? (no id)
    const isNotification = req.id === undefined;

    try {
      const resp = await this.dispatch(req);
      if (!isNotification && resp) {
        this.send(resp);
      }
    } catch (err: unknown) {
      if (!isNotification) {
        this.sendError(
          req.id ?? null,
          -32603,
          `Internal error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  private async dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    switch (req.method) {
      case "initialize":
        return this.handleInitialize(req);

      case "notifications/initialized":
      case "initialized":
        this.initialized = true;
        return null; // Notifications have no response

      case "ping":
        return { jsonrpc: "2.0", id: req.id ?? null, result: {} };

      case "tools/list":
        return this.handleToolsList(req);

      case "tools/call":
        return await this.handleToolsCall(req);

      default:
        return {
          jsonrpc: "2.0",
          id: req.id ?? null,
          error: {
            code: -32601,
            message: `Method not found: '${req.method}'`,
          },
        };
    }
  }

  private handleInitialize(req: JsonRpcRequest): JsonRpcResponse {
    return {
      jsonrpc: "2.0",
      id: req.id ?? null,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {
            listChanged: false,
          },
        },
        serverInfo: {
          name: "antigravity-coms-net",
          version: "0.1.0",
        },
      },
    };
  }

  private handleToolsList(req: JsonRpcRequest): JsonRpcResponse {
    return {
      jsonrpc: "2.0",
      id: req.id ?? null,
      result: {
        tools: MCP_TOOLS_DEFINITIONS,
      },
    };
  }

  private async handleToolsCall(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const params = req.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    const toolName = params?.name;
    const toolArgs = params?.arguments ?? {};

    if (!toolName) {
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        error: { code: -32602, message: "Missing required parameter 'name' in tools/call" },
      };
    }

    // Verify valid tool name
    const declaredTool = MCP_TOOLS_DEFINITIONS.find((t) => t.name === toolName);
    if (!declaredTool) {
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        result: {
          content: [{ type: "text", text: `Error: Unknown tool '${toolName}'` }],
          isError: true,
        },
      };
    }

    // Lazy initialization & hub connection check
    let tools: ComsNetTools;
    try {
      tools = await this.ensureInitialized();
    } catch (err: unknown) {
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        result: {
          content: [
            {
              type: "text",
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        },
      };
    }

    // Execute requested tool
    try {
      let result: McpCallToolResult;

      switch (toolName) {
        case "coms_net_list": {
          const res = await tools.list(toolArgs as unknown as ToolListParams);
          result = { content: res.content, isError: (res as { isError?: boolean }).isError ?? false };
          break;
        }
        case "coms_net_send": {
          const res = await tools.send(toolArgs as unknown as ToolSendParams);
          result = { content: res.content, isError: (res as { isError?: boolean }).isError ?? false };
          break;
        }
        case "coms_net_get": {
          const res = await tools.get(toolArgs as unknown as ToolGetParams);
          result = { content: res.content, isError: res.isError ?? false };
          break;
        }
        case "coms_net_await": {
          const res = await tools.await(toolArgs as unknown as ToolAwaitParams);
          result = { content: res.content, isError: res.isError ?? false };
          break;
        }
        default:
          result = {
            content: [{ type: "text", text: `Error: Unhandled tool '${toolName}'` }],
            isError: true,
          };
      }

      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        result,
      };
    } catch (err: unknown) {
      return {
        jsonrpc: "2.0",
        id: req.id ?? null,
        result: {
          content: [
            {
              type: "text",
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        },
      };
    }
  }

  private async ensureInitialized(): Promise<ComsNetTools> {
    if (this.tools) return this.tools;

    let client = this.client;
    if (!client) {
      let discovery: DiscoveryResult;
      try {
        discovery = await discoverHub(this.options.discoveryOptions);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `coms-net hub discovery failed: ${message}\n` +
          `Ensure the coms-net server is running or set PI_COMS_NET_SERVER_URL and PI_COMS_NET_AUTH_TOKEN.`
        );
      }

      client = new ComsNetClient({
        baseUrl: discovery.config.baseUrl,
        authToken: discovery.config.authToken,
        project: discovery.config.project,
      });
      this.client = client;
    }

    let lifecycle = this.lifecycle;
    if (!lifecycle) {
      lifecycle = new AgentLifecycle({
        client,
        name: this.options.agentName || process.env.COMS_NET_AGENT_NAME || "antigravity-mcp",
        purpose: this.options.agentPurpose || "Antigravity CLI MCP Client",
        model: process.env.COMS_NET_MODEL || "gemini-3.7-flash-high",
        provider: "antigravity",
        explicit: true,
        heartbeatIntervalMs: 10_000,
        autoInstallSignalHandlers: false,
      });

      try {
        await lifecycle.start();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to register MCP client with coms-net hub: ${message}`
        );
      }
      this.lifecycle = lifecycle;
    } else if (!lifecycle.getCard()) {
      try {
        await lifecycle.start();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Failed to register MCP client with coms-net hub: ${message}`
        );
      }
    }

    const card = lifecycle.getCard();
    if (!card) {
      throw new Error("Failed to obtain agent card from lifecycle");
    }

    this.tools = new ComsNetTools({
      client,
      identity: {
        session_id: card.session_id,
        name: card.name,
        project: card.project,
        cwd: card.cwd,
      },
      pendingReplies: this.pendingReplies,
    });

    return this.tools;
  }

  private send(resp: JsonRpcResponse): void {
    this.output.write(JSON.stringify(resp) + "\n");
  }

  private sendError(id: string | number | null, code: number, message: string): void {
    this.send({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });
  }
}

// ── Auto-Start CLI Runner ───────────────────────────────────────────────────

export async function runMcpServer(): Promise<void> {
  const server = new McpServer();

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.start();
}

// Execute if run directly
const isMain = process.argv[1] && (
  fileURLToPath(import.meta.url) === process.argv[1] ||
  import.meta.url === `file://${process.argv[1]}`
);
if (isMain) {
  runMcpServer().catch((err) => {
    process.stderr.write(`Fatal MCP server error: ${err}\n`);
    process.exit(1);
  });
}
