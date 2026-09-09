# Antigravity Coms-Net Architecture

## 1. System Overview

`antigravity-coms-net` is an integration bridge that connects Antigravity CLI (`agy`) agents into the `coms-net` multi-agent communication mesh. It allows autonomous agents running in local or remote environments—including reference Pi agents and peer Antigravity agents—to collaborate as equal, decentralized peers.

### Core Objectives
1. **First-Class Antigravity Presence**: Provide Antigravity agents with a persistent identity (`AgentCard`), dynamic metrics reporting, and self-healing presence on the coms-net hub.
2. **Asymmetric Peer-to-Peer Communication**: Use standard HTTP REST for outbound commands and long-polling, combined with persistent Server-Sent Events (SSE) for real-time inbound prompt streaming.
3. **Headless Turn Execution**: Handle inbound prompts autonomously by executing headless `agy` turns (`agy -p`), capturing the assistant response, validating schemas, and submitting replies back to the hub.
4. **Standard Model Context Protocol (MCP)**: Expose the four core coms-net collaboration tools (`coms_net_list`, `coms_net_send`, `coms_net_get`, `coms_net_await`) over stdio JSON-RPC 2.0 to interactive Antigravity CLI sessions.
5. **Zero External Runtime Dependencies**: Built entirely on Node.js standard libraries (`node:http`, `node:crypto`, `node:fs`, `node:child_process`, `node:readline`, `node:events`).

---

## 2. System Architecture & Component Interaction

### 2.1 High-Level Architecture Diagram

```
+---------------------------------------------------------------------------------------+
|                                  coms-net Server Hub                                  |
|                             (HTTP REST API + SSE Broadcast)                           |
|                                                                                       |
|   Endpoints:                                         SSE Events (/v1/events):         |
|   - GET  /health                                     - hello          - agent_stale   |
|   - POST /v1/agents/register                         - pool_snapshot  - agent_left    |
|   - POST /v1/agents/:id/heartbeat                    - agent_joined   - prompt        |
|   - GET  /v1/agents                                  - agent_updated  - response      |
|   - POST /v1/messages                                - message_status - : ping        |
|   - GET  /v1/messages/:id & /await                                                    |
|   - POST /v1/messages/:id/response                                                    |
|   - DELETE /v1/agents/:id                                                             |
+-------------------------------------------+-------------------------------------------+
                                            ^
                         HTTP REST & SSE    |    Bearer Auth & Keepalive
                                            v
+---------------------------------------------------------------------------------------+
|                             Antigravity Coms-Net Bridge                               |
|                                                                                       |
|  +---------------------------+   +-------------------------------------------------+  |
|  |    Discovery Subsystem    |   |            Protocol Client Subsystem            |  |
|  | - CLI / ENV / File cascade|   | - Authenticated REST dispatcher (fetch)         |  |
|  | - Mode 0600 secret guard  |-->| - Timeout controllers & unref timers            |  |
|  | - Path traversal guard    |   | - 2-stage connectivity validation               |  |
|  | - Zero-leak token redact  |   | - Dual-signal abort propagation                 |  |
|  +---------------------------+   +------------------------+------------------------+  |
|                                                           |                           |
|              +--------------------------------------------+                           |
|              |                            |                                           |
|              v                            v                                           |
|  +---------------------------+   +------------------------+   +--------------------+  |
|  | Agent Lifecycle Subsystem |   |  SSE Stream Subsystem  |   |    Tools Engine    |  |
|  | - AgentCard generator     |   | - WHATWG Stream parser |   | - coms_net_list    |  |
|  | - 10s heartbeat daemon    |   | - Exponential backoff  |   | - coms_net_send    |  |
|  | - Name collision resolver |   | - Keepalive ping parser|   | - coms_net_get     |  |
|  | - Auto-re-registration    |   | - Pre-reconnect upsert |   | - coms_net_await   |  |
|  +-------------+-------------+   +-----------+------------+   +---------+----------+  |
|                |                             |                          |             |
|                +--------------+  +-----------+                          |             |
|                               |  |                                      |             |
|                               v  v                                      |             |
|  +--------------------------------------------------------+             |             |
|  |                 Bridge Daemon Coordinator              |             |             |
|  | - Inbound FIFO turn queue & concurrency gate           |             |             |
|  | - Response schema validation (direct JSON / markdown)  |             |             |
|  | - Process signal trapping (SIGINT / SIGTERM / exit)    |             |             |
|  | - Inbound context tracking & hop incrementing          |             |             |
|  +----------------------------+---------------------------+             |             |
|                               |                                         |             |
|                               v                                         |             |
|  +--------------------------------------------------------+             |             |
|  |                 Turn Execution Subsystem               |             |             |
|  | - Headless CLI executor: agy -p "$prompt" --output json|             |             |
|  | - Anti-loop prompt envelope injection                  |             |             |
|  | - JSON output parser & execution metrics extraction    |             |             |
|  | - Hermetic mock turn executor for isolated test suites |             |             |
|  +----------------------------+---------------------------+             |             |
+-------------------------------|-----------------------------------------|-------------+
                                | child_process                           | JSON-RPC
                                v (headless)                              v (stdio)
+-----------------------------------+   +-----------------------------------------------+
|         Antigravity CLI           |   |            Antigravity CLI Session            |
|       Turn Subprocess (agy)       |   |      (Interactive terminal / Agent work)      |
| - Executes model prompt           |   | - Uses .agents/plugins/coms-net/              |
| - Produces assistant text output  |   | - Interacts with mesh peers via stdio MCP     |
+-----------------------------------+   +-----------------------------------------------+
```

---

## 3. Subsystem Deep Dives

### 3.1 Hub Discovery Subsystem (`src/protocol/discovery.ts`)

The discovery subsystem resolves connection parameters (`baseUrl`, `authToken`, `project`) needed to communicate with the hub.

#### Precedence Hierarchy
Configuration values are resolved strictly using the following priority order (highest to lowest):
1. **Explicit programmatic options / CLI flags**: `--server-url`, `--auth-token`, `--project`.
2. **Environment variables**: `PI_COMS_NET_SERVER_URL`, `PI_COMS_NET_AUTH_TOKEN`, `PI_COMS_NET_PROJECT`.
3. **Local filesystem registry**:
   - URL from `~/.pi/coms-net/projects/<project>/server.json` (`local_url`).
   - Token from `~/.pi/coms-net/projects/<project>/server.secret.json` (`token`).

#### Security & Integrity Guards
- **POSIX Mode 0600 Verification**: `server.secret.json` contains the sensitive pre-shared Bearer token. The reader inspects file metadata using `fs.statSync(path)` and strictly requires `st.mode & 0o777 === 0o600` (read/write by owner only). Files with permissions like `0644`, `0660`, or `0777` are rejected with diagnostic errors.
- **Symlink Protection**: `fs.lstatSync(path).isSymbolicLink()` ensures the secret file is not a symbolic link, preventing privilege escalation or symlink redirection attacks.
- **Path Traversal Protection**: Project namespace strings are strictly validated against `/^[a-zA-Z0-9_-]+$/`. Attempts to use `../` or invalid path characters throw `InvalidProjectNameError`.
- **Zero-Leak Token Redaction**: In all diagnostics, logs, and thrown error instances, raw token values and Bearer authentication headers are sanitized via `redactToken()`.

---

### 3.2 Protocol REST Client Subsystem (`src/protocol/client.ts`)

The `ComsNetClient` provides typed, authenticated HTTP communication with the hub.

#### Key Architectural Features
- **Zero Runtime Dependencies**: Wraps native `globalThis.fetch` with optional dependency injection (`fetchFn`) for hermetic mock testing.
- **Bearer Token Injection**: Automatically attaches `Authorization: Bearer <authToken>` to all authenticated `/v1/*` requests.
- **Timeout Management & Unref Timers**: Every request is bounded by an `AbortController` timeout (default 10,000ms). Timeout timers call `.unref?.()` so they do not artificially prevent Node.js process termination.
- **Dual-Signal Cancellation**: When callers pass an external `AbortSignal` (e.g., user cancellation or connection abort), an internal listener synchronizes both the timeout abort and the external signal cleanly.
- **2-Stage Connectivity Validation**: `validateConnectivity()` verifies hub reachability via unauthenticated `GET /health`, then verifies token authentication via `GET /v1/agents`, reporting clear diagnostic status.
- **Network Error Classification**: Maps socket failures (`ECONNREFUSED`, `ENOTFOUND`, `EHOSTUNREACH`) and timeouts (`AbortError`) into typed subclasses (`ConnectionRefusedError`, `RequestTimeoutError`) while stripping tokens from error messages.

---

### 3.3 Agent Lifecycle & Presence Subsystem (`src/bridge/lifecycle.ts`)

The `AgentLifecycle` manages agent presence, heartbeat reporting, and deconfliction.

#### Agent Identity & Card Synthesis
- Generates a canonical 26-character Crockford Base32 ULID for `session_id`.
- Deterministically generates a neon hex color based on the SHA-256 hash of `session_id` unless explicitly configured.
- Resolves default agent names (`antigravity-<short-id>`) and tags the runtime as `"antigravity"`.

#### Name Collision Resolution
When registering with `POST /v1/agents/register`, if another online agent already holds the desired name, the server appends a numerical suffix (`name2`, `name3`). The lifecycle detects this divergence between desired and assigned name, updates internal state, and emits a `name_collision` event.

#### Periodic Heartbeat Loop
- Runs every 10,000ms (`DEFAULT_HEARTBEAT_INTERVAL_MS`) with a 5,000ms network timeout.
- Pulls dynamic metrics (`context_used_pct`, `queue_depth`, `model`, `status`) via `DynamicMetricProvider`.
- Suppresses overlapping concurrent heartbeats via reentrancy guard (`isHeartbeatInFlight`).
- **Self-Healing on Purge**: If the heartbeat returns HTTP 404 (`agent_not_found`), indicating the agent was purged due to missed heartbeats or server restart, the lifecycle immediately performs an automatic re-registration (`reRegister()`) upsert.
- Emits `heartbeat_stale_warning` if 3 consecutive heartbeat attempts fail.

---

### 3.4 SSE Stream Listener Subsystem (`src/bridge/sse.ts`)

The SSE listener establishes a persistent event stream (`GET /v1/events?project=...&session_id=...`) to receive hub pushes.

#### WHATWG Stream Chunk Parsing (`SseParser`)
- Decodes binary chunks using `TextDecoder("utf-8", { stream: true })`.
- Handles arbitrary TCP chunk boundaries: multi-byte UTF-8 sequences fractured across chunks, frames split across reads, and multiple frames within a single chunk.
- Supports both `\r\n\r\n` and `\n\n` event boundaries.
- Joins multi-line `data:` fields with `\n` and parses JSON payloads.
- Intercepts comment lines starting with `:` for keepalive pings (`: ping <timestamp>`).

#### Reconnection & Resilience (`SseEventListener`)
- Emits typed events: `hello`, `pool_snapshot`, `agent_joined`, `agent_updated`, `agent_stale`, `agent_left`, `prompt`, `response`, `message_status`, and `ping`.
- Reconnects automatically using exponential backoff: starts at 500ms, doubles per failure up to a ceiling of 10,000ms.
- **Pre-Reconnect Upsert**: Invokes `registerFn()` before reopening the SSE stream to guarantee that the agent card exists in server memory, preventing HTTP 404 errors during reconnection.

---

### 3.5 Turn Execution Engine Subsystem (`src/bridge/turn-executor.ts`)

The turn execution engine handles incoming prompts dispatched via SSE `prompt` events.

#### Headless CLI Invocation (`AgyCliTurnExecutor`)
- Executes the Antigravity CLI binary non-interactively using `node:child_process.execFile`:
  ```bash
  agy -p "$prompt" --output-format json --dangerously-skip-permissions [--conversation "$id"] [--model "$model"] [--effort "$effort"]
  ```
- Uses a 20MB buffer and configurable execution timeout (default 300,000ms / 5 minutes).

#### Anti-Looping Prompt Envelope
To prevent an LLM from mistakenly calling `coms_net_send` to reply to an inbound message (which would cause an infinite ping-pong loop), `formatInboundPrompt()` prepends a strict envelope:
```
[inbound coms-net message from <sender_name> @ <sender_cwd>]
[reply by writing a normal assistant message — your turn output is auto-returned to <sender_name>. DO NOT call coms_net_send/coms_net_await/coms_net_get to reply; that creates a ping-pong loop. msg_id <msg_id> belongs to <sender_name>'s outbound, not yours.]

<original_prompt>
```

#### Output Parsing & Schema Validation
- Extracts JSON payload from stdout using robust brace boundary matching (`indexOf("{")` and `lastIndexOf("}")`), ignoring surrounding CLI warnings or formatting noise.
- Validates the response against `response_schema` if requested by the sender:
  1. Direct JSON parsing.
  2. Markdown code block extraction (` ```json ... ``` ` or ` ``` ... ``` `).
  3. If schema is specified and JSON extraction fails, returns `{ payload: null, error: "response not valid JSON" }` per coms-net specification.

---

### 3.6 Stdio MCP Server Subsystem (`src/mcp/server.ts`)

The MCP server exposes coms-net tools to Antigravity CLI sessions via standard Model Context Protocol (MCP 2024-11-05).

#### JSON-RPC 2.0 Transport
- Uses newline-delimited JSON over `process.stdin` and `process.stdout`.
- All logging, debug output, and errors are isolated strictly to `process.stderr` (`[mcp-server]`), ensuring stdout remains pure JSON-RPC.

#### Exposed Tools
1. `coms_net_list`: Query peer roster with context usage and live status.
2. `coms_net_send`: Submit outbound prompt to a peer (enforces hops < 5, returns `msg_id`).
3. `coms_net_get`: Non-blocking poll of message reply (fast-path cache + HTTP GET).
4. `coms_net_await`: Suspend until reply arrives (3-way race: SSE promise, HTTP long-poll, timeout).

#### Lazy Discovery & MCP Agent Presence
- Defers hub discovery and registration until the first tool call is received.
- Registers an agent card with `explicit: true` so the MCP client session does not clutter peer rosters.
- Automatically unregisters and closes timers when stdin closes or the process exits.

---

### 3.7 Bridge Daemon Subsystem (`src/bridge/daemon.ts`)

The `BridgeDaemon` coordinates all subsystems into an autonomous background daemon.

#### Concurrency & FIFO Turn Queue
- Maintains a FIFO queue of inbound prompt events.
- Enforces `maxConcurrentTurns` (default 1) to prevent resource exhaustion and model contention.
- Sets `currentInbound` context during execution so that any outbound sub-prompts inherit `hops = currentInbound.hops + 1`.

#### Response Submission
Upon turn completion, the daemon packages the assistant response (or error) and submits it to `POST /v1/messages/:msg_id/response` with `responder_session` validation.

#### Process Signal Trapping
Installs handlers for `SIGINT`, `SIGTERM`, and `beforeExit`:
1. Closes the SSE event stream.
2. Stops the heartbeat loop.
3. Synchronously/asynchronously calls `DELETE /v1/agents/:session_id` with a 2,000ms timeout to unregister from the hub.
4. Clears in-flight queues and exits cleanly.
