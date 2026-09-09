# Antigravity Coms-Net (`antigravity-coms-net`)

[![Node.js](https://img.shields.io/badge/Node.js-≥22.13.0-brightgreen.svg)](https://nodejs.org/)
[![Antigravity CLI](https://img.shields.io/badge/Antigravity_CLI-≥1.1.28-blue.svg)](https://github.com/google/antigravity)
[![Zero Dependencies](https://img.shields.io/badge/Runtime_Dependencies-0-success.svg)](#zero-runtime-dependency-architecture)
[![License](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/Tests-143_Passing-brightgreen.svg)](#testing)

**Antigravity Coms-Net** is the official Antigravity CLI (`agy`) integration for the **coms-net multi-agent mesh network**. It enables Antigravity agents to join decentralized agent pools, discover active peers, send structured cross-agent prompts, await peer responses, and autonomously execute inbound turns dispatched by [Pi agents](https://github.com/mariozechner/pi-coding-agent) or peer Antigravity agents.

---

## Table of Contents

- [Overview](#overview)
- [Zero-Runtime-Dependency Architecture](#zero-runtime-dependency-architecture)
- [Prerequisites & Environment](#prerequisites--environment)
- [Installation](#installation)
- [Quickstart Guide](#quickstart-guide)
  - [1. Connect via Antigravity Plugin (Recommended)](#1-connect-via-antigravity-plugin-recommended)
  - [2. Register MCP Server Manually (`agy mcp add`)](#2-register-mcp-server-manually-agy-mcp-add)
  - [3. Run the Autonomous Bridge Daemon](#3-run-the-autonomous-bridge-daemon)
- [CLI Reference: `coms-net-bridge`](#cli-reference-coms-net-bridge)
- [MCP Tools Reference](#mcp-tools-reference)
  - [`coms_net_list`](#1-coms_net_list)
  - [`coms_net_send`](#2-coms_net_send)
  - [`coms_net_get`](#3-coms_net_get)
  - [`coms_net_await`](#4-coms_net_await)
- [Multi-Agent Interaction Scenarios](#multi-agent-interaction-scenarios)
  - [Scenario A: Antigravity Agent Delegating to a Pi Agent](#scenario-a-antigravity-agent-delegating-to-a-pi-agent)
  - [Scenario B: Heterogeneous Multi-Agent Mesh Collaboration](#scenario-b-heterogeneous-multi-agent-mesh-collaboration)
- [Security & Anti-Looping Discipline](#security--anti-looping-discipline)
- [Testing](#testing)
- [License](#license)

---

## Overview

The `coms-net` mesh protocol establishes flat, bidirectional agent-to-agent communication without centralized hierarchy or information loss. Unlike rigid top-down orchestrators, any agent on the network can discover peers, delegate specialized tasks, and synthesize results.

```
                          ┌─────────────────────────────────────┐
                          │         coms-net Server Hub         │
                          │     (REST API + SSE Broadcasts)     │
                          └──────────────────┬──────────────────┘
                                             │
                       HTTP REST & SSE       │
             ┌───────────────────────────────┴───────────────────────────────┐
             │                                                               │
┌────────────▼──────────────────────┐                     ┌──────────────────▼────────────────┐
│     Pi Agent (Reference Peer)     │                     │    Antigravity Bridge Daemon      │
│  - ~/.pi/coms-net/                │                     │  - Discovery (server.json / env)  │
│  - extensions/coms-net.ts         │                     │  - 10s Heartbeat Loop             │
│  - Reactive UI & Pool Widget      │                     │  - SSE Event Listener             │
└───────────────────────────────────┘                     │  - Headless Turn Executor (agy -p)│
                                                          └──────────────────┬────────────────┘
                                                                             │
                                                                   MCP JSON-RPC / stdio
                                                                             │
                                                          ┌──────────────────▼────────────────┐
                                                          │     Antigravity CLI Session       │
                                                          │  - .agents/plugins/coms-net/      │
                                                          │  - Rules (rules/AGENTS.md)        │
                                                          │  - Skills (skills/coms-net-collab)│
                                                          └───────────────────────────────────┘
```

### Key Capabilities

- **Bidirectional Peer-to-Peer Interaction**: Prompts and responses flow fluidly in both directions between heterogeneous AI models (`gemini-3.7-pro`, `gemini-3.7-flash`, `claude-sonnet-4-6`, `gpt-5.5`).
- **Headless Turn Execution**: Background bridge daemon receives inbound SSE prompt events, executes autonomous Antigravity turns via `agy -p "$prompt" --output-format json --dangerously-skip-permissions`, and submits outputs back to the hub.
- **Strict Anti-Looping Safeguards**: Architectural envelope tagging prevents LLM ping-pong recursion, while a strict hop counter (`MAX_HOPS = 5`) rejects runaway cascading loops.
- **Fast Local Resolution with Abortable Network Race**: `coms_net_await` evaluates responses across a 3-way concurrent race (local SSE push event, HTTP server long-poll, and client timeout) and terminates open sockets immediately upon resolution.
- **Automated Hub Self-Healing**: Resilient SSE stream auto-reconnects with exponential backoff (500ms to 10s with jitter), while heartbeat tracking automatically recovers from 404 session expirations.

---

## Zero-Runtime-Dependency Architecture

`antigravity-coms-net` ships with **0 production runtime dependencies** (`package.json` `"dependencies": {}`).

Every subsystem is engineered directly on native Node.js 22 built-ins:
- **Transport & Networking**: Native global `fetch` and `node:http` for REST communication and streaming Server-Sent Events (SSE).
- **Process Orchestration**: `node:child_process` (`execFile`, `spawn`) for spawning Antigravity turn executions and subagents.
- **Cryptographic Identifiers**: `node:crypto` for generating 26-character Crockford Base32 ULIDs without external UUID packages.
- **Stream Decoding**: Pure incremental chunk parser (`SseParser`) handling TCP fragmentation, CRLF normalization, and fragmented multi-byte UTF-8 byte sequences.
- **Stdio Framing**: `node:readline` managing strict line-delimited JSON-RPC 2.0 stdio framing for MCP clients.

---

## Prerequisites & Environment

1. **Node.js**: Version **>= 22.13.0** (supports native `--experimental-strip-types` and built-in `fetch`).
2. **Antigravity CLI**: Version **>= 1.1.28** installed and available in `$PATH`:
   ```bash
   agy --version
   ```
3. **Running Coms-Net Hub**: A local or remote hub server. If using the reference Bun hub:
   ```bash
   # From ~/Code/pi-coms-net
   bun scripts/coms-net-server.ts
   # Hub will write ~/.pi/coms-net/projects/default/server.json and server.secret.json
   ```

---

## Installation

Clone the repository and build the TypeScript binaries:

```bash
cd ~/Code/antigravity-coms-net

# Install development toolchain (TypeScript, Node typings)
npm install

# Compile TypeScript to dist/
npm run build
```

The compiled binaries are placed in `dist/` and exposed via executable wrapper scripts in `bin/`:
- `bin/coms-net-bridge.js`: Bridge daemon entrypoint.
- `bin/coms-net-mcp.js`: Stdio MCP server entrypoint.

Optionally, link the binaries globally to your PATH:
```bash
npm link
```

---

## Quickstart Guide

### 1. Connect via Antigravity Plugin (Recommended)

The cleanest way to use coms-net in Antigravity CLI sessions is via the bundled plugin in `.agents/plugins/coms-net/`. It automatically registers the MCP server, collaboration rules, and skills.

Verify the plugin manifest and configuration:
```bash
agy plugin validate .agents/plugins/coms-net
```

Expected output:
```text
  [ok]    .agents/plugins/coms-net
          ✔ skills      : 1 processed
          - agents      : skipped (not found)
          - commands    : skipped (not found)
          ✔ mcpServers  : 1 processed
          - hooks       : skipped (not found)
```

To enable the plugin for your workspace, ensure your `.agents/` directory points to the plugin, or install it:
```bash
agy plugin install .agents/plugins/coms-net
```

Start an interactive Antigravity session:
```bash
agy
```
The four tools (`coms_net_list`, `coms_net_send`, `coms_net_get`, `coms_net_await`) are now loaded in the agent's context.

---

### 2. Register MCP Server Manually (`agy mcp add`)

If you prefer registering the MCP server directly into your global or local Antigravity CLI configuration without installing the full plugin bundle:

```bash
# Add coms-net MCP server using compiled binary
agy mcp add coms-net node $(pwd)/dist/mcp/server.js

# Or with custom environment overrides (e.g. custom project namespace)
agy mcp add --env COMS_NET_PROJECT=dev-sprint coms-net node $(pwd)/dist/mcp/server.js
```

Verify that the MCP server is configured:
```bash
agy mcp list
```

---

### 3. Run the Autonomous Bridge Daemon

To allow **other agents to send prompts to your Antigravity agent**, run the bridge daemon in a dedicated terminal or as a system service. The daemon registers on the hub, maintains the 10-second heartbeat loop, listens to SSE events, and executes inbound turns via headless `agy -p`:

```bash
# Start bridge daemon using hub auto-discovery
npm run bridge

# Or directly via binary
./bin/coms-net-bridge.js --name agy-worker --purpose "TypeScript architecture and testing specialist"
```

Console output:
```text
[bridge] Hub connected at http://127.0.0.1:34567 (server_id: srv_01J7AB...)
[bridge] Project: default (URL from file, token from secret_file)
[bridge] Turn executor: AgyCliTurnExecutor (model: default)
[bridge] Agent registered: agy-worker (session_id: 01J7ABCDEF0123456789ABCDEF)
[bridge] Status: active, CWD: /home/matt/Code/antigravity-coms-net
[bridge] SSE event stream connected. Listening for inbound prompts...
```

---

## CLI Reference: `coms-net-bridge`

`coms-net-bridge` accepts the following options:

| Flag | Short | Default | Description |
| :--- | :---: | :---: | :--- |
| `--project <name>` | `-p` | `"default"` | Target project namespace (overridden by `$PI_COMS_NET_PROJECT`). Must match `^[a-zA-Z0-9_-]+$`. |
| `--server-url <url>` | `-u` | *auto-discovered* | HTTP URL of the coms-net hub (overridden by `$PI_COMS_NET_SERVER_URL`). |
| `--auth-token <token>`| `-t` | *auto-discovered* | Hub authorization Bearer token (overridden by `$PI_COMS_NET_AUTH_TOKEN`). |
| `--name <name>` | `-n` | `antigravity-<hostname>` | Agent name to register on the hub. Names are automatically de-conflicted if collisions occur. |
| `--purpose <text>` | | `"Antigravity CLI bridge agent"` | Agent purpose description visible to peers in `coms_net_list`. |
| `--model <model>` | `-m` | *CLI default* | Model override passed to headless turn execution (e.g. `gemini-3.7-flash-high`, `gemini-3.7-pro`). |
| `--cwd <path>` | | *process cwd* | Working directory context where `agy -p` commands will execute. |
| `--mock` | | `false` | Run in hermetic mock mode using `MockTurnExecutor` (bypasses `agy` CLI for fast CI testing). |
| `--mock-response <txt>` | | `"Mock response from..."` | Canned response text returned when running in `--mock` mode. |
| `--max-turns <n>` | | `1` | Maximum concurrent turn executions handled by the internal FIFO queue. |
| `--heartbeat-ms <n>` | | `10000` | Heartbeat pulse interval in milliseconds (default: 10 seconds). |
| `--explicit` | | `false` | Mark agent as explicit/hidden (hidden from default `coms_net_list` roster unless requested). |
| `--help` | `-h` | | Display help message and exit. |
| `--version` | `-v` | | Display version number and exit. |

### Environment Variables

| Variable | Description |
| :--- | :--- |
| `PI_COMS_NET_PROJECT` | Default project namespace if `-p` is omitted. |
| `PI_COMS_NET_SERVER_URL` | Hub REST/SSE server base URL. Highest precedence over `server.json`. |
| `PI_COMS_NET_AUTH_TOKEN` | Bearer authorization token. Highest precedence over `server.secret.json`. |
| `PI_COMS_NET_DIR` | Custom hub discovery registry root (defaults to `~/.pi/coms-net`). |
| `AGY_BIN_PATH` | Path to the `agy` executable (defaults to searching `$PATH`). |

---

## MCP Tools Reference

The integration registers four standard tools conforming to the coms-net protocol.

### 1. `coms_net_list`

Discovers active peer agents registered on the coms-net hub for the current project.

- **Parameters**:
  - `project` (*string*, optional): Namespace project name. Defaults to current active project.
  - `include_explicit` (*boolean*, optional): When `true`, includes explicit/hidden agents. Default is `false`.
- **Return Example**:
  ```text
  3 peer(s):
  ● pi-reviewer (sonnet-4-6) 14% — TypeScript security and architecture auditor
  ● coder-agent (flash-3.7) 22% — Fast refactoring and implementation worker
  ~ data-analyst (opus-4-7) ?% — Log analysis and metrics reporter
  ```
  *(Presence indicators: `●` online, `~` stale, `✗` offline)*.

---

### 2. `coms_net_send`

Initiates an outbound prompt to a target peer agent.

- **Parameters**:
  - `target` (*string*, **required**): Unique peer agent name (e.g. `"pi-reviewer"`) or 26-character ULID `session_id`.
  - `prompt` (*string*, **required**): The prompt text to deliver. Provide self-contained context, file paths, and instructions.
  - `conversation_id` (*string*, optional): Conversation thread ID for continuing multi-turn dialogues.
  - `response_schema` (*object*, optional): JSON Schema enforcing structured output validation on the responder's reply.
- **Return Example**:
  ```text
  coms_net_send → pi-reviewer
  msg_id 01J7ABCDEF0123456789ABCDEF
  hops 0
  ```
- **⚠️ Anti-Looping Notice**: Never call `coms_net_send` to reply to an incoming message. Formulate your answer directly in your assistant message text.

---

### 3. `coms_net_get`

Performs a non-blocking inspection of a previously dispatched outbound message.

- **Parameters**:
  - `msg_id` (*string*, **required**): The 26-character ULID returned by `coms_net_send`.
- **Return Example (Complete)**:
  ```text
  coms_net_get: complete
  Audit complete: No security vulnerabilities found.
  ```
- **Return Example (Pending)**:
  ```text
  coms_net_get: delivered
  ```

---

### 4. `coms_net_await`

Blocks until the responder completes the turn and delivers the answer, or until the timeout expires.

- **Parameters**:
  - `msg_id` (*string*, **required**): The 26-character ULID returned by `coms_net_send`.
  - `timeout_ms` (*number*, optional): Milliseconds to wait before timing out (default: 1,800,000 ms / 30 minutes).
- **Execution Race**: Concurrently races local SSE events, HTTP long-polling (`GET /v1/messages/:msg_id/await`), and client timers.
- **Return Example**:
  ```json
  {
    "status": "complete",
    "response": "All unit tests compiled cleanly and passed with 100% coverage."
  }
  ```

---

## Multi-Agent Interaction Scenarios

### Scenario A: Antigravity Agent Delegating to a Pi Agent

An interactive Antigravity CLI session delegates security auditing to an online Pi agent (`pi-reviewer`), awaits the result, and synthesizes the review:

```
[Antigravity Session]            [coms-net Hub]                  [Pi Agent: pi-reviewer]
         │                              │                                    │
         │  1. coms_net_list()          │                                    │
         ├─────────────────────────────►│                                    │
         │  ◄── [pi-reviewer (online)]  │                                    │
         │                              │                                    │
         │  2. coms_net_send("pi-rev")  │                                    │
         ├─────────────────────────────►│  3. SSE Broadcast: 'prompt'       │
         │  ◄── { msg_id: "01J7AB..." } ├───────────────────────────────────►│
         │                              │                                    │ 4. Turn execution
         │  5. coms_net_await("01J7AB") │                                    │    in Pi agent
         ├─────────────────────────────►│                                    │
         │   (3-way race waiting)       │  6. POST /messages/:id/response    │
         │                              │◄───────────────────────────────────┤
         │  7. SSE 'response' / HTTP    │                                    │
         │◄─────────────────────────────┤                                    │
         │                              │                                    │
         ▼ 8. Synthesize audit          │                                    │
```

1. **Discovery**: Antigravity agent runs `coms_net_list()` and identifies `pi-reviewer`.
2. **Send**: Antigravity agent runs `coms_net_send("pi-reviewer", "Please review src/protocol/discovery.ts for path traversal risks.")`. Receives `msg_id: "01J7ABCDEF..."`.
3. **Await**: Antigravity agent calls `coms_net_await("01J7ABCDEF...")`.
4. **Execution**: The Pi agent processes the prompt in its own environment and returns its review.
5. **Synthesis**: The response unblocks `coms_net_await` and the Antigravity agent reports the verdict to the user.

---

### Scenario B: Heterogeneous Multi-Agent Mesh Collaboration

Two Antigravity agents running with different models (`planner` on `gemini-3.7-pro` and `coder` on `gemini-3.7-flash-high`) collaborate on feature implementation:

```
┌─────────────────────────┐               ┌─────────────────────────┐
│     planner (Pro)       │               │      coder (Flash)      │
│ Model: gemini-3.7-pro   │               │ Model: gemini-3.7-flash │
└───────────┬─────────────┘               └───────────┬─────────────┘
            │                                         │
            │  1. coms_net_send(target: "coder",     │
            │     prompt: "Implement ULID generator") │
            ├────────────────────────────────────────►│
            │  2. coms_net_await(...)                 │  3. Inbound SSE event
            │     [blocks]                            │  4. Runs agy -p
            │                                         │     generates Crockford Base32
            │                                         │  5. Captures assistant text
            │  6. Response delivered                  │  6. Submits response to hub
            │◄────────────────────────────────────────┤
            ▼                                         │
    7. Validates code                                 │
```

---

## Security & Anti-Looping Discipline

### POSIX Mode 0600 Security Check
To protect hub authorization credentials, `coms-net` enforces strict POSIX file permissions:
- When reading `~/.pi/coms-net/projects/<project>/server.secret.json`, permissions must strictly match `0600` (`st.mode & 0o777 === 0o600`).
- Looser permissions (e.g. `0644`, `0777`) or symbolic links are strictly rejected with security diagnostics.

### Strict Anti-Looping Discipline
When an agent receives an inbound message, the bridge prepends an anti-looping envelope:
```text
[inbound coms-net message from sender @ /path]
[reply by writing a normal assistant message — your turn output is auto-returned to sender.
DO NOT call coms_net_send to reply; that creates a ping-pong loop.]
```
- **The Golden Rule**: The responder agent must answer directly in its normal assistant text. Calling `coms_net_send` creates a duplicate message thread and initiates an infinite ping-pong loop.
- **Hop Counter**: Every message tracks `hops`. If an agent chains delegations beyond `MAX_HOPS = 5`, message dispatch is aborted with `HopLimitExceededError`.

---

## Testing

The project includes an extensive automated test suite covering unit tests, mock hub integration, and adversarial stress scenarios.

Run the test suite via Node.js native test runner:
```bash
npm test
```

Expected output:
```text
ℹ tests 143
ℹ suites 26
ℹ pass 143
ℹ fail 0
```

Additional checks:
```bash
# Typecheck TypeScript sources
npm run typecheck

# Validate Antigravity plugin manifest and configuration
npm run validate:plugin
```

---

## License

MIT © Antigravity Team
