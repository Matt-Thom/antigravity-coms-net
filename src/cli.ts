/**
 * src/cli.ts
 *
 * Command line entrypoint for the Antigravity Coms-Net bridge daemon.
 *
 * Usage:
 *   $ coms-net-bridge [options]
 *   $ npx tsx src/cli.ts [options]
 */

import * as os from "node:os";
import * as fs from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { ComsNetClient } from "./protocol/client.ts";
import { discoverHubSync } from "./protocol/discovery.ts";
import { BridgeDaemon } from "./bridge/daemon.ts";
import {
  AgyCliTurnExecutor,
  MockTurnExecutor,
  type ITurnExecutor,
} from "./bridge/turn-executor.ts";
import type { AgentCard, DiscoveryResult } from "./protocol/types.ts";

export interface BridgeCliArgs {
  project?: string;
  serverUrl?: string;
  authToken?: string;
  name?: string;
  purpose?: string;
  model?: string;
  mock: boolean;
  mockResponse?: string;
  cwd?: string;
  maxTurns?: number;
  heartbeatMs?: number;
  explicit?: boolean;
  help: boolean;
  version: boolean;
}

const PARSE_OPTIONS = {
  project: { type: "string" as const, short: "p" },
  "server-url": { type: "string" as const, short: "u" },
  "auth-token": { type: "string" as const, short: "t" },
  name: { type: "string" as const, short: "n" },
  purpose: { type: "string" as const },
  model: { type: "string" as const, short: "m" },
  mock: { type: "boolean" as const, default: false },
  "mock-response": { type: "string" as const },
  cwd: { type: "string" as const },
  "max-turns": { type: "string" as const },
  "heartbeat-ms": { type: "string" as const },
  explicit: { type: "boolean" as const, default: false },
  help: { type: "boolean" as const, short: "h", default: false },
  version: { type: "boolean" as const, short: "v", default: false },
};

export function getVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgUrl, "utf-8"));
    return pkg.version || "0.1.0";
  } catch {
    return "0.1.0";
  }
}

export function getHelpText(): string {
  return `
coms-net-bridge — Antigravity CLI Bridge Daemon for Coms-Net Mesh

USAGE:
  $ coms-net-bridge [options]

OPTIONS:
  -p, --project <project>       Target project namespace (default: "default" or $PI_COMS_NET_PROJECT)
  -u, --server-url <url>        Coms-net hub URL (default: discovered via server.json or $PI_COMS_NET_SERVER_URL)
  -t, --auth-token <token>      Hub auth token (default: discovered via server.secret.json or $PI_COMS_NET_AUTH_TOKEN)
  -n, --name <name>             Agent name to register (default: antigravity-<hostname>)
      --purpose <text>          Agent purpose description (default: "Antigravity CLI bridge agent")
  -m, --model <model>           LLM model override for turn execution (e.g. "gemini-3.7-flash-high")
      --cwd <path>              Working directory for agent execution (default: current directory)
      --mock                    Run in hermetic mock mode using MockTurnExecutor
      --mock-response <text>    Canned response string for mock mode
      --max-turns <n>           Maximum concurrent turn executions (default: 1)
      --heartbeat-ms <n>        Heartbeat interval in milliseconds (default: 10000)
      --explicit                Mark agent as explicit (hidden from default roster)
  -h, --help                    Show this help message and exit
  -v, --version                 Show version information and exit

ENVIRONMENT VARIABLES:
  PI_COMS_NET_PROJECT           Default project namespace
  PI_COMS_NET_SERVER_URL        Hub server URL override
  PI_COMS_NET_AUTH_TOKEN        Hub auth token override
  PI_COMS_NET_DIR               Directory for filesystem discovery (default: ~/.pi/coms-net)
  AGY_BIN_PATH                  Path to agy binary (default: "agy")

EXAMPLES:
  # Start bridge using auto-discovery on default project
  $ coms-net-bridge

  # Join a custom project with custom name and model
  $ coms-net-bridge -p dev-sprint -n coder-1 -m gemini-3.7-flash-high

  # Connect to explicit remote hub
  $ coms-net-bridge -u http://127.0.0.1:34567 -t secret123

  # Run in hermetic mock mode for testing/CI
  $ coms-net-bridge --mock --mock-response "Task completed successfully."
`.trim();
}

export function parseCliArgs(args: string[] = process.argv.slice(2)): BridgeCliArgs {
  const { values } = parseArgs({
    args,
    options: PARSE_OPTIONS,
    strict: true,
    allowPositionals: false,
  });

  let maxTurns: number | undefined;
  if (values["max-turns"] !== undefined) {
    const val = parseInt(values["max-turns"], 10);
    if (isNaN(val) || val <= 0) {
      throw new Error(
        `Invalid --max-turns value '${values["max-turns"]}': must be a positive integer`
      );
    }
    maxTurns = val;
  }

  let heartbeatMs: number | undefined;
  if (values["heartbeat-ms"] !== undefined) {
    const val = parseInt(values["heartbeat-ms"], 10);
    if (isNaN(val) || val <= 0) {
      throw new Error(
        `Invalid --heartbeat-ms value '${values["heartbeat-ms"]}': must be a positive integer`
      );
    }
    heartbeatMs = val;
  }

  return {
    project: values.project,
    serverUrl: values["server-url"],
    authToken: values["auth-token"],
    name: values.name,
    purpose: values.purpose,
    model: values.model,
    mock: values.mock ?? false,
    mockResponse: values["mock-response"],
    cwd: values.cwd,
    maxTurns,
    heartbeatMs,
    explicit: values.explicit ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
  };
}

export async function runBridgeDaemon(args: BridgeCliArgs): Promise<BridgeDaemon> {
  // 1. Discover hub parameters
  let discovery: DiscoveryResult;
  try {
    discovery = discoverHubSync({
      project: args.project,
      serverUrl: args.serverUrl,
      authToken: args.authToken,
    });
  } catch (err: unknown) {
    console.error(`[bridge] Discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // 2. Instantiate and verify client
  const client = new ComsNetClient({
    baseUrl: discovery.config.baseUrl,
    authToken: discovery.config.authToken,
    project: discovery.config.project,
  });

  try {
    const health = await client.getHealth();
    console.log(`[bridge] Hub connected at ${discovery.config.baseUrl} (server_id: ${health.server_id})`);
    console.log(`[bridge] Project: ${discovery.config.project} (URL from ${discovery.source.urlSource}, token from ${discovery.source.tokenSource})`);
  } catch (err: unknown) {
    console.error(`[bridge] Cannot reach hub at ${discovery.config.baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // 3. Resolve turn executor
  let turnExecutor: ITurnExecutor;
  if (args.mock) {
    const defaultResponse = args.mockResponse || "Mock response from Antigravity Bridge";
    turnExecutor = new MockTurnExecutor({ defaultResponse });
    console.log(`[bridge] Turn executor: MockTurnExecutor (canned response configured)`);
  } else {
    turnExecutor = new AgyCliTurnExecutor({
      model: args.model,
      cwd: args.cwd || process.cwd(),
    });
    console.log(`[bridge] Turn executor: AgyCliTurnExecutor (model: ${args.model || "default"})`);
  }

  // 4. Default agent name
  const defaultName = `antigravity-${os.hostname().toLowerCase().replace(/[^a-z0-9_-]/g, "")}`;
  const agentName = args.name || defaultName;

  // 5. Instantiate BridgeDaemon
  const daemon = new BridgeDaemon({
    client,
    turnExecutor,
    name: agentName,
    purpose: args.purpose || "Antigravity CLI bridge agent",
    model: args.model,
    cwd: args.cwd || process.cwd(),
    explicit: args.explicit,
    maxConcurrentTurns: args.maxTurns,
    heartbeatIntervalMs: args.heartbeatMs,
    autoTrapSignals: true,
  });

  // 6. Bind event logging
  daemon.on("started", (card: AgentCard) => {
    console.log(`[bridge] Agent registered: ${card.name} (session_id: ${card.session_id})`);
    console.log(`[bridge] Status: ${card.status}, CWD: ${card.cwd}`);
  });

  daemon.on("name_collision", (data: { requestedName: string; assignedName: string }) => {
    console.warn(`[bridge] Name collision: '${data.requestedName}' was taken; registered as '${data.assignedName}'`);
  });

  daemon.on("sse_connected", () => {
    console.log(`[bridge] SSE event stream connected. Listening for inbound prompts...`);
  });

  daemon.on("sse_disconnected", (reason: string) => {
    console.warn(`[bridge] SSE stream disconnected (${reason}). Reconnecting...`);
  });

  daemon.on("prompt_received", (evt) => {
    console.log(`[bridge] Prompt received [msg_id=${evt.msg_id}] from ${evt.sender_name} (${evt.sender_session})`);
  });

  daemon.on("turn_started", (evt) => {
    console.log(`[bridge] Executing turn for [msg_id=${evt.msg_id}]...`);
  });

  daemon.on("turn_completed", (data) => {
    console.log(`[bridge] Turn completed for [msg_id=${data.msg_id}]`);
  });

  daemon.on("turn_error", (data) => {
    console.error(`[bridge] Turn error for [msg_id=${data.msg_id}]:`, data.error);
  });

  daemon.on("response_submitted", (data) => {
    console.log(`[bridge] Response submitted to hub for [msg_id=${data.msg_id}]`);
  });

  daemon.on("heartbeat_failed", (err) => {
    console.warn(`[bridge] Heartbeat failed: ${err.message}`);
  });

  daemon.on("stopped", () => {
    console.log(`[bridge] Bridge daemon stopped.`);
  });

  // 7. Start daemon
  await daemon.start();
  return daemon;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let args: BridgeCliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err: unknown) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    console.error("Run with --help for usage information.");
    process.exit(1);
  }

  if (args.help) {
    console.log(getHelpText());
    process.exit(0);
  }

  if (args.version) {
    console.log(`coms-net-bridge v${getVersion()}`);
    process.exit(0);
  }

  await runBridgeDaemon(args);
}

// Auto-run if executed directly as a script
const isMain = process.argv[1] && (
  fileURLToPath(import.meta.url) === process.argv[1] ||
  import.meta.url === `file://${process.argv[1]}`
);
if (isMain) {
  main().catch((err) => {
    console.error(`[bridge] Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
