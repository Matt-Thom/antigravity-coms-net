# coms-net Protocol Specification (v1)

## 1. Architectural Principles & Transport

The `coms-net` multi-agent protocol is a lightweight communication substrate enabling peer-to-peer collaboration among autonomous AI agents.

### 1.1 Core Principles
1. **Flat Peer-to-Peer Topology**: All registered agents are autonomous peers within a project namespace. There is no hardcoded hierarchical manager or central orchestrator.
2. **Asymmetric Transport**:
   - **Agent-to-Hub**: Standard HTTP/1.1 REST endpoints (`POST`, `GET`, `DELETE`).
   - **Hub-to-Agent**: Persistent Server-Sent Events (`GET /v1/events`) and HTTP long-polling (`GET /v1/messages/:msg_id/await`).
3. **Project Namespace Isolation**: Agents, messages, and events are strictly partitioned by project name (`project`, defaulting to `"default"`).
4. **Token Authentication**: All endpoints under `/v1/*` require an HTTP `Authorization: Bearer <token>` header. The `/health` endpoint is unauthenticated.
5. **Presence & Heartbeat**: Agents report liveness every 10 seconds. Agents missing heartbeats for >30 seconds transition to `stale`; agents missing heartbeats for >60 seconds are purged as `offline`.
6. **Hop Limits & Loop Prevention**: Outbound messages carry a `hops` counter. Hops $\ge 5$ are rejected. Inbound messages are answered via turn output response submission, not via reciprocal `coms_net_send`.

---

## 2. Identifiers & Wire Data Schemas

### 2.1 Identifiers
- `server_id`, `session_id`, `msg_id`: 26-character Crockford Base32 Universal Unique Lexicographically Sortable Identifiers (ULID). Format: `[0-9A-HJKMNP-TV-Z]{26}`.

### 2.2 Status Enumerations
- `AgentStatus`: `"online"` | `"stale"` | `"offline"`
- `MessageStatus`: `"queued"` | `"delivered"` | `"complete"` | `"error"` | `"timeout"`
- `DisconnectReason`: `"shutdown"` | `"connection_closed"` | `"stale"`

### 2.3 AgentCard Schema
```json
{
  "session_id": "01JM78XYZ456789ABCDEFGHJKM",
  "name": "antigravity-worker",
  "purpose": "Executes coding tasks and automated tests",
  "model": "gemini-2.5-pro",
  "provider": "google",
  "color": "#36F9F6",
  "cwd": "/home/matt/Code/project",
  "project": "default",
  "explicit": false,
  "started_at": "2026-09-09T05:49:10.000Z",
  "context_used_pct": 18,
  "queue_depth": 0,
  "status": "online",
  "runtime": "antigravity"
}
```

### 2.4 Error Envelope Schema
All API errors return a standard JSON envelope:
```json
{
  "ok": false,
  "error": "<error_code>",
  "details": "<optional_primitive_or_object>"
}
```

---

## 3. REST API Specification (10 Endpoints)

### 3.1 `GET /health`
Liveness probe and hub identity check.

- **Auth**: None
- **Query Parameters**: None
- **Request Body**: None
- **Response**: `200 OK`
  ```json
  {
    "ok": true,
    "version": 1,
    "server_id": "01JM78XYZ456789ABCDEFGHJKM",
    "started_at": "2026-09-09T05:00:00.000Z"
  }
  ```

---

### 3.2 `POST /v1/agents/register`
Registers a new agent session or updates an existing registration (upsert).

- **Auth**: `Bearer <token>`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "project": "default",
    "session_id": "01JM78XYZ456789ABCDEFGHJKM",
    "name": "coder",
    "purpose": "Code generation and review",
    "model": "gemini-2.5-pro",
    "provider": "google",
    "color": "#36F9F6",
    "cwd": "/home/matt/Code/app",
    "explicit": false,
    "runtime": "antigravity"
  }
  ```
- **Responses**:
  - `200 OK`:
    ```json
    {
      "ok": true,
      "agent": { ...AgentCard },
      "heartbeat_interval_ms": 10000,
      "sse_url": "/v1/events?project=default&session_id=01JM78XYZ456789ABCDEFGHJKM"
    }
    ```
  - `400 Bad Request`: `invalid_json` or `invalid_request` (missing `session_id` or `name`).
  - `401 Unauthorized`: Invalid or missing token.
- **Side Effects**: If desired name conflicts with an existing agent, server assigns a unique suffixed name (e.g. `coder2`). Broadcasts `agent_joined` SSE event to all peers in the project.

---

### 3.3 `POST /v1/agents/:session_id/heartbeat`
Periodic liveness ping and dynamic metrics update.

- **Auth**: `Bearer <token>`
- **Headers**: `Content-Type: application/json`
- **Path Parameter**: `session_id` (ULID)
- **Request Body**:
  ```json
  {
    "project": "default",
    "context_used_pct": 35,
    "queue_depth": 1,
    "model": "gemini-2.5-pro",
    "status": "online"
  }
  ```
- **Responses**:
  - `200 OK`: `{"ok": true}`
  - `400 Bad Request`: `invalid_json`
  - `401 Unauthorized`: `unauthorized`
  - `404 Not Found`: `agent_not_found`
- **Side Effects**: Updates `last_seen_at`. If metrics change, broadcasts `agent_updated` SSE event to other peers.

---

### 3.4 `GET /v1/agents`
Lists registered agents in the project namespace.

- **Auth**: `Bearer <token>`
- **Query Parameters**:
  - `project` (string, optional, default: `"default"`): Project namespace.
  - `include_explicit` (string, optional, default: `"false"`): When `"true"`, includes explicit/hidden agents.
- **Request Body**: None
- **Responses**:
  - `200 OK`:
    ```json
    {
      "agents": [ { ...AgentCard } ]
    }
    ```
  - `401 Unauthorized`: `unauthorized`

---

### 3.5 `POST /v1/messages`
Dispatches an outbound prompt message to a peer agent.

- **Auth**: `Bearer <token>`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "project": "default",
    "sender_session": "01JM78XYZ456789ABCDEFGHJKM",
    "target": "reviewer",
    "target_session": null,
    "prompt": "Please review the auth middleware in src/auth.ts",
    "conversation_id": "conv-101",
    "response_schema": null,
    "hops": 0
  }
  ```
- **Responses**:
  - `200 OK`:
    ```json
    {
      "ok": true,
      "msg_id": "01JM79ABC123456789DEFGHJKM",
      "status": "delivered",
      "target_session": "01JM78REV987654321ABCDEFGH"
    }
    ```
    *Note*: `status` is `"delivered"` if target's SSE stream is open, otherwise `"queued"`.
  - `400 Bad Request`: `invalid_json`, `invalid_request`, or `missing_target`.
  - `401 Unauthorized`: `unauthorized`.
  - `404 Not Found`: `target_not_found` or `sender_not_registered`.
  - `409 Conflict`:
    - `hop_limit_exceeded`: `hops >= 5`.
    - `ambiguous_target`: Friendly target name matches multiple online sessions.
  - `429 Too Many Requests`: `inbox_full` (target pending messages $\ge 100$).
- **Side Effects**: Emits `message_status` (`queued`) to sender. If target stream is open, pushes `prompt` event to target and emits `message_status` (`delivered`) to sender.

---

### 3.6 `GET /v1/messages/:msg_id`
Non-blocking status inspection of a dispatched message.

- **Auth**: `Bearer <token>`
- **Path Parameter**: `msg_id` (ULID)
- **Request Body**: None
- **Responses**:
  - `200 OK`:
    ```json
    {
      "msg_id": "01JM79ABC123456789DEFGHJKM",
      "status": "complete",
      "response": "Authentication middleware review passed.",
      "error": null
    }
    ```
  - `401 Unauthorized`: `unauthorized`
  - `404 Not Found`: `message_not_found`

---

### 3.7 `GET /v1/messages/:msg_id/await`
Suspends connection (HTTP long-polling) until message reaches a terminal state.

- **Auth**: `Bearer <token>`
- **Path Parameter**: `msg_id` (ULID)
- **Query Parameters**:
  - `timeout_ms` (number, optional, default: 30000, max: 1800000): Wait timeout in milliseconds.
- **Request Body**: None
- **Responses**:
  - `200 OK`:
    ```json
    {
      "msg_id": "01JM79ABC123456789DEFGHJKM",
      "status": "complete",
      "response": "...",
      "error": null
    }
    ```
    If `timeout_ms` expires before completion:
    ```json
    {
      "msg_id": "01JM79ABC123456789DEFGHJKM",
      "status": "timeout",
      "response": null,
      "error": "timeout"
    }
    ```
  - `401 Unauthorized`: `unauthorized`
  - `404 Not Found`: `message_not_found`
- **Side Effects**: Detaches listener cleanly if client aborts HTTP request.

---

### 3.8 `POST /v1/messages/:msg_id/response`
Submits final assistant execution output or error for a delivered message.

- **Auth**: `Bearer <token>`
- **Headers**: `Content-Type: application/json`
- **Path Parameter**: `msg_id` (ULID)
- **Request Body**:
  ```json
  {
    "project": "default",
    "responder_session": "01JM78REV987654321ABCDEFGH",
    "response": "Authentication middleware review passed.",
    "error": null
  }
  ```
- **Responses**:
  - `200 OK`: `{"ok": true}`
  - `400 Bad Request`: `invalid_json` or `invalid_request` (missing `responder_session`).
  - `401 Unauthorized`: `unauthorized`.
  - `403 Forbidden`: `not_target` (`responder_session` does not match message `target_session`).
  - `404 Not Found`: `message_not_found`.
  - `409 Conflict`: `already_terminal` (message already complete, error, or timeout).
- **Side Effects**: Updates message status (`complete` or `error`). Pushes `response` and `message_status` SSE events to original sender. Resolves all HTTP awaiters waiting on `msg_id`.

---

### 3.9 `DELETE /v1/agents/:session_id`
Gracefully unregisters an agent session from the hub.

- **Auth**: `Bearer <token>`
- **Path Parameter**: `session_id` (ULID)
- **Query Parameters**:
  - `project` (string, optional, default: `"default"`)
- **Request Body**: None
- **Responses**:
  - `200 OK`: `{"ok": true}`
  - `401 Unauthorized`: `unauthorized`
  - `404 Not Found`: `agent_not_found`
- **Side Effects**: Closes active SSE streams for this session. Removes agent from registry and indices. Broadcasts `agent_left` SSE event (`reason: "shutdown"`) to peers.

---

### 3.10 `GET /v1/events` (SSE Stream)
Opens a persistent Server-Sent Events stream for push event notifications.

- **Auth**: `Bearer <token>`
- **Headers**:
  - `Accept: text/event-stream`
- **Query Parameters**:
  - `session_id` (string, required): Agent session ULID.
  - `project` (string, optional, default: `"default"`): Project namespace.
- **Responses**:
  - `200 OK`: Stream opened (`Content-Type: text/event-stream; charset=utf-8`).
  - `400 Bad Request`: `missing_session_id`.
  - `401 Unauthorized`: `unauthorized`.
  - `404 Not Found`: `agent_not_found` (agent must call `/register` before connecting).
- **Side Effects**: Emits initial `hello` and `pool_snapshot` events immediately. On disconnect, broadcasts `agent_left` (`reason: "connection_closed"`).

---

## 4. SSE Wire Protocol & Event Catalog (10 Events)

### 4.1 Wire Framing Format
Standard events:
```
event: <event_name>\n
id: <sequential_int_per_stream>\n
data: <json_string>\n\n
```

Keepalive ping comments:
```
: ping <ISO8601_timestamp>\n\n
```

---

### 4.2 Event Catalog

#### 1. `hello`
Initial handshake event sent immediately upon stream opening.
- **Target**: Connecting client only
- **Payload**:
  ```json
  {
    "server_time": "2026-09-09T05:49:10.000Z",
    "server_id": "01JM78XYZ456789ABCDEFGHJKM"
  }
  ```

#### 2. `pool_snapshot`
Delivered immediately after `hello` with all current active peers in project.
- **Target**: Connecting client only (excludes self and explicit agents)
- **Payload**:
  ```json
  {
    "project": "default",
    "agents": [ { ...AgentCard } ]
  }
  ```

#### 3. `agent_joined`
Broadcast when a new peer registers or an existing peer re-registers (upsert).
- **Target**: All project peers except the joining agent
- **Payload**:
  ```json
  {
    "project": "default",
    "agent": { ...AgentCard }
  }
  ```

#### 4. `agent_updated`
Broadcast when a peer reports changes in context usage, queue depth, model, or status.
- **Target**: All project peers except reporting agent
- **Payload**:
  ```json
  {
    "project": "default",
    "agent": {
      "session_id": "01JM78XYZ456789ABCDEFGHJKM",
      "name": "coder",
      "context_used_pct": 42,
      "queue_depth": 0,
      "model": "gemini-2.5-pro",
      "status": "online"
    }
  }
  ```

#### 5. `agent_stale`
Broadcast by background monitor when a peer misses heartbeats for >30 seconds.
- **Target**: All project peers except the stale agent
- **Payload**:
  ```json
  {
    "project": "default",
    "session_id": "01JM78XYZ456789ABCDEFGHJKM",
    "name": "coder",
    "last_seen_at": "2026-09-09T05:48:40.000Z"
  }
  ```

#### 6. `agent_left`
Broadcast when a peer leaves the network.
- **Target**: All project peers except departing agent
- **Payload**:
  ```json
  {
    "project": "default",
    "session_id": "01JM78XYZ456789ABCDEFGHJKM",
    "name": "coder",
    "reason": "shutdown"
  }
  ```
  *Reasons*: `"shutdown"` (explicit delete), `"connection_closed"` (TCP disconnect), `"stale"` (>60s missed heartbeats).

#### 7. `prompt`
Delivered to a target agent when an inbound message arrives.
- **Target**: Target agent only
- **Payload**:
  ```json
  {
    "msg_id": "01JM79ABC123456789DEFGHJKM",
    "project": "default",
    "sender": {
      "session_id": "01JM78XYZ456789ABCDEFGHJKM",
      "name": "planner",
      "cwd": "/home/matt/Code/project"
    },
    "prompt": "Run the test suite",
    "conversation_id": "conv-101",
    "response_schema": null,
    "hops": 0
  }
  ```

#### 8. `response`
Delivered to original sender when target submits assistant response.
- **Target**: Sender agent only
- **Payload**:
  ```json
  {
    "msg_id": "01JM79ABC123456789DEFGHJKM",
    "project": "default",
    "responder": {
      "session_id": "01JM78REV987654321ABCDEFGH",
      "name": "worker"
    },
    "response": "All 148 tests passed.",
    "error": null,
    "status": "complete"
  }
  ```

#### 9. `message_status`
Pushed to sender when message state updates (`queued`, `delivered`, `complete`, `error`, `timeout`).
- **Target**: Sender agent only
- **Payload**:
  ```json
  {
    "msg_id": "01JM79ABC123456789DEFGHJKM",
    "status": "delivered"
  }
  ```

#### 10. Keepalive Comment (`server_ping`)
- Wire Format: `: ping 2026-09-09T05:49:10.000Z\n\n`
- Frequency: Emitted every 15,000ms by hub background timer to maintain TCP connection across proxies and NAT gateways.

---

## 5. Error Taxonomy & Wire Codes

| HTTP Status | Error Code | Description | Details Object Schema |
|---|---|---|---|
| 400 | `invalid_request` | Missing required payload parameters | None |
| 400 | `invalid_json` | Request body is not parseable JSON | None |
| 400 | `missing_target` | Target name or target_session not supplied | None |
| 400 | `missing_session_id` | Missing session_id query param on `/v1/events` | None |
| 401 | `unauthorized` | Missing or invalid Bearer authentication token | None |
| 403 | `not_target` | Responder session is not the target of this message | None |
| 404 | `agent_not_found` | Agent session not registered in hub | None |
| 404 | `sender_not_registered` | Sender session not found in hub registry | None |
| 404 | `target_not_found` | Target agent friendly name or session not found | `{"target": "<name>"}` |
| 404 | `message_not_found` | Message ID not found in hub memory | None |
| 409 | `ambiguous_target` | Target friendly name matches multiple active sessions | `{"target": "<name>", "candidates": ["<sid1>", "<sid2>"]}` |
| 409 | `hop_limit_exceeded` | Message hops $\ge$ maximum allowable ceiling (5) | `{"hops": <n>, "max_hops": 5}` |
| 409 | `already_terminal` | Response submitted for completed/error message | `{"status": "<complete\|error\|timeout>"}` |
| 429 | `inbox_full` | Target pending message queue depth $\ge 100$ | `{"depth": <n>, "max_inbox": 100}` |

---

## 6. Timing Constants, Hop Limits, and Anti-Looping Rules

### 6.1 Protocol Timing Constants

| Constant Name | Default Value | Config Environment Variable | Description |
|---|---|---|---|
| `HEARTBEAT_INTERVAL_MS` | `10,000 ms` | `PI_COMS_NET_HEARTBEAT_MS` | Interval between agent presence heartbeats |
| `STALE_AFTER_MS` | `30,000 ms` | `PI_COMS_NET_STALE_AFTER_MS` | Elapsed time without heartbeat before agent marked `stale` |
| `OFFLINE_AFTER_MS` | `60,000 ms` | `PI_COMS_NET_OFFLINE_AFTER_MS`| Elapsed time without heartbeat before agent purged |
| `MESSAGE_TTL_MS` | `1,800,000 ms` | `PI_COMS_NET_MESSAGE_TTL_MS` | Time-to-live for queued messages (30 minutes) |
| `SSE_KEEPALIVE_MS` | `15,000 ms` | N/A | Frequency of `: ping` comments on SSE stream |
| `SSE_RECONNECT_BASE_MS` | `500 ms` | N/A | Starting delay for exponential backoff reconnect |
| `SSE_RECONNECT_MAX_MS` | `10,000 ms` | N/A | Maximum delay cap for exponential backoff reconnect |
| `DEFAULT_AWAIT_TIMEOUT_MS`| `30,000 ms` | N/A | Default long-polling wait time for HTTP await |

### 6.2 Hop Ceiling & Forwarding Safeguards
- **Ceiling**: Enforces `MAX_HOPS = 5`.
- **Client Enforcement**: Before calling `POST /v1/messages`, client checks if `hops >= 5`. If violated, throws `HopLimitExceededError` without network round-trip.
- **Server Enforcement**: The server hub checks incoming hops; returns `HTTP 409 hop_limit_exceeded` if `hops >= 5`.

### 6.3 Anti-Looping Architecture
1. **Turn Output Capture**: When answering an inbound message, agents reply directly via turn completion output. The bridge automatically captures this output and submits it to `POST /v1/messages/:msg_id/response`. Agents MUST NOT call `coms_net_send` to reply.
2. **Hop Incrementing on Sub-delegation**: If an agent receiving an inbound prompt needs to delegate a sub-task to another agent, the client increments the hop count:
   $$\text{hops}_{\text{out}} = \text{hops}_{\text{in}} + 1$$
   This strictly bounds nested delegation chains to a maximum depth of 5.
3. **Instruction Injection**: The bridge prepends an anti-looping system instruction to the model prompt warning it that its normal assistant text is auto-returned and forbidding tool calls to reply.
