---
name: coms-net-collab
description: Multi-agent collaboration across the coms-net mesh network. Use this skill when delegating subtasks to peer agents, querying active peers, sending cross-agent prompts, awaiting peer responses, or coordinating distributed agent workflows.
---

# Coms-Net Multi-Agent Collaboration Skill

This skill guides you through discovering, communicating with, and coordinating peer agents across the coms-net multi-agent mesh.

## When to Use This Skill
Activate this skill when:
- The user requests delegating work to another agent (e.g. "Ask pi-reviewer to audit this change").
- You need specialized assistance from another agent running on the network (e.g. Python code execution, automated testing, research).
- You want to discover available peer agents and their active models.
- You need to coordinate parallel work across multiple AI agents.

---

## Standard Collaboration Workflow

```
[1. Discover Peers]       Call coms_net_list() to find online agents
         │
         ▼
[2. Select Target]        Match agent role, model, and status ("online")
         │
         ▼
[3. Dispatch Prompt]      Call coms_net_send(target, prompt, ...) -> returns msg_id
         │
         ▼
[4. Await Response]       Call coms_net_await(msg_id, timeout_ms) -> blocks until ready
         │
         ▼
[5. Synthesize Result]    Incorporate peer output into your final answer
```

---

## Core Tool Reference

### 1. `coms_net_list`
Queries the coms-net hub for registered active agents.

**Parameters:**
- `project` (*string*, optional): Namespace project name. Defaults to current active project.
- `include_explicit` (*boolean*, optional): When `true`, includes explicit/hidden agents. Default is `false`.

**Return Payload:**
- Formatted list of peers showing presence bullet (`●` online, `~` stale, `✗` offline), agent name, model abbreviation, context usage percentage, and declared purpose.

---

### 2. `coms_net_send`
Dispatches an outbound task or inquiry prompt to a target agent.

**Parameters:**
- `target` (*string*, **required**): Unique agent name (e.g. `"pi-reviewer"`) or 26-character ULID `session_id`.
- `prompt` (*string*, **required**): The prompt text to deliver. Provide self-contained context.
- `conversation_id` (*string*, optional): Session thread ID for multi-turn conversations.
- `response_schema` (*object*, optional): JSON Schema object enforcing structured JSON output from the responder.

**Return Payload:**
- `msg_id` (*string*): 26-character ULID message identifier.
- `status` (*string*): `"queued"` or `"delivered"`.
- `target_session` (*string*): Resolved ULID session ID of the target agent.
- `hops` (*number*): Current message hop count.

---

### 3. `coms_net_await`
Blocks execution until the responder agent completes the turn and returns an output, or until the timeout expires.

**Parameters:**
- `msg_id` (*string*, **required**): The ULID message ID returned by `coms_net_send`.
- `timeout_ms` (*number*, optional): Milliseconds to wait before timing out (default: 1,800,000 ms / 30 mins).

**Return Payload:**
- `status`: `"complete"` | `"error"` | `"timeout"`.
- `response`: The completed text or structured JSON object returned by the responder.
- `error`: Error message string if `status` is `"error"` or `"timeout"`.

---

### 4. `coms_net_get`
Performs a fast non-blocking poll to check if a message has finished.

**Parameters:**
- `msg_id` (*string*, **required**): The ULID message ID returned by `coms_net_send`.

**Return Payload:**
- `status`: `"queued"` | `"delivered"` | `"complete"` | `"error"` | `"timeout"`.
- `response`: Responder output if complete, else `null`.

---

## Practical Collaboration Examples

### Example 1: Delegating Code Review to a Peer Agent
**Scenario**: You have refactored a TypeScript module and want the peer agent `pi-reviewer` to audit the diff.

**Step 1: Discover peers**
```json
// Tool Call: coms_net_list
{}
```
*Output*:
```
● pi-reviewer (sonnet-4-6) 14% — TypeScript security and architecture auditor
● python-runner (flash-3.7) 5% — Hermetic Python sandbox executor
```

**Step 2: Dispatch prompt to `pi-reviewer`**
```json
// Tool Call: coms_net_send
{
  "target": "pi-reviewer",
  "prompt": "Please review this diff in src/protocol/discovery.ts for path traversal risks and POSIX permission checks:\n\n```diff\n+ if ((stat.mode & 0o777) !== 0o600) throw new SecurityError('Invalid permissions');\n```"
}
```
*Output*:
```json
{
  "msg_id": "01J7ABCDEF0123456789ABCDEF",
  "status": "delivered",
  "target_session": "01J7AB00000000000000000000",
  "hops": 0
}
```

**Step 3: Await response**
```json
// Tool Call: coms_net_await
{
  "msg_id": "01J7ABCDEF0123456789ABCDEF",
  "timeout_ms": 60000
}
```
*Output*:
```json
{
  "status": "complete",
  "response": "Diff review complete: The bitwise check `(stat.mode & 0o777) !== 0o600` correctly enforces strict user-read/write permissions. Approved."
}
```

---

### Example 2: Structured JSON Schema Enforcement
**Scenario**: You need a test generation peer (`test-gen-agent`) to return machine-readable test cases conforming to a JSON Schema.

```json
// Tool Call: coms_net_send
{
  "target": "test-gen-agent",
  "prompt": "Generate 3 edge-case test specs for the Crockford Base32 ULID generator.",
  "response_schema": {
    "type": "object",
    "properties": {
      "testCases": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "inputTimestamp": { "type": "number" },
            "expectedLength": { "type": "number" }
          },
          "required": ["name", "inputTimestamp", "expectedLength"]
        }
      }
    },
    "required": ["testCases"]
  }
}
```

**Await response**:
```json
// Tool Call: coms_net_await
{
  "msg_id": "01J7ABCDEF0123456789ABCDEF"
}
```
*Output*:
```json
{
  "status": "complete",
  "response": {
    "testCases": [
      { "name": "epoch_zero", "inputTimestamp": 0, "expectedLength": 26 },
      { "name": "far_future", "inputTimestamp": 253402300799000, "expectedLength": 26 },
      { "name": "sub_millisecond_drift", "inputTimestamp": 1725868800000, "expectedLength": 26 }
    ]
  }
}
```

---

### Example 3: Multi-turn Dialogue with Conversation Continuity
**Scenario**: You are having an ongoing consultation with `data-analyst`.

```json
// Tool Call: coms_net_send
{
  "target": "data-analyst",
  "prompt": "Can we also filter those metrics by response latency < 50ms?",
  "conversation_id": "conv-data-analysis-thread-42"
}
```

---

## Protocol Anti-Looping Notice (CRITICAL)

**When you receive an inbound prompt from another agent:**
- The prompt will be prefixed with `[inbound coms-net message from <name>]`.
- **Do NOT invoke `coms_net_send`, `coms_net_await`, or `coms_net_get`.**
- Simply formulate your response naturally in your assistant message text. The bridge daemon captures your final output and submits it to the hub automatically.
- Calling `coms_net_send` creates a duplicate outbound message, resulting in an infinite ping-pong loop.
