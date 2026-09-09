# Coms-Net Antigravity Usage Guide & Tutorials

Welcome to the comprehensive operational guide for the **Antigravity Coms-Net** multi-agent integration. This guide provides step-by-step tutorials covering multi-agent coordination, structured JSON schema validation, error recovery, and anti-looping best practices.

---

## Table of Contents

1. [Tutorial 1: End-to-End Multi-Agent Setup](#tutorial-1-end-to-end-multi-agent-setup)
2. [Tutorial 2: Structured JSON Schema Enforcement](#tutorial-2-structured-json-schema-enforcement)
3. [Tutorial 3: Multi-Turn Dialogues & Conversation State](#tutorial-3-multi-turn-dialogues--conversation-state)
4. [Tutorial 4: Error Handling & Network Resilience](#tutorial-4-error-handling--network-resilience)
5. [Tutorial 5: Anti-Looping Discipline & Hop Limits](#tutorial-5-anti-looping-discipline--hop-limits)

---

## Tutorial 1: End-to-End Multi-Agent Setup

In this tutorial, you will spin up a local multi-agent mesh consisting of:
1. A **coms-net Server Hub**.
2. A background **Antigravity Bridge Daemon** (`agy-worker`) listening for tasks.
3. An interactive **Antigravity CLI Session** (`agy-lead`) delegating work.

### Step 1: Launch the coms-net Server Hub
Start the hub server in Terminal 1:
```bash
# If using the reference hub:
cd ~/Code/pi-coms-net
bun scripts/coms-net-server.ts
```
The server binds to `127.0.0.1` and writes credentials to:
- `~/.pi/coms-net/projects/default/server.json`
- `~/.pi/coms-net/projects/default/server.secret.json` (POSIX mode `0600`)

### Step 2: Start the Antigravity Bridge Daemon
Open Terminal 2 and launch the bridge daemon. This agent will handle inbound tasks autonomously:
```bash
cd ~/Code/antigravity-coms-net
./bin/coms-net-bridge.js \
  --name agy-worker \
  --purpose "Specialized backend refactoring and testing agent" \
  --model gemini-3.7-flash-high
```
The daemon registers as `agy-worker`, begins heartbeating every 10 seconds, and connects to the SSE event stream.

### Step 3: Launch Interactive Antigravity CLI Session
Open Terminal 3 and launch your interactive Antigravity CLI session with the plugin enabled:
```bash
cd ~/Code/antigravity-coms-net
agy
```

### Step 4: Discover Peers and Dispatch Work
In your interactive prompt:
```text
User: Check what agents are online on the coms-net hub.
```
The agent executes `coms_net_list` and reports:
```text
Found 1 peer agent:
● agy-worker (flash-3.7) 0% — Specialized backend refactoring and testing agent
```

Now delegate a task to `agy-worker`:
```text
User: Ask agy-worker to generate a unit test file for our Base32 decoder.
```
The agent executes:
```json
// Tool: coms_net_send
{
  "target": "agy-worker",
  "prompt": "Create a unit test in tests/unit/base32.test.ts testing Crockford Base32 decoding."
}
```
Followed immediately by:
```json
// Tool: coms_net_await
{
  "msg_id": "01J7ABCDEF0123456789ABCDEF",
  "timeout_ms": 60000
}
```
In Terminal 2, you will observe `agy-worker` execute the headless turn and submit the response back. In Terminal 3, `coms_net_await` returns the generated test code, which the lead agent presents to you.

---

## Tutorial 2: Structured JSON Schema Enforcement

When orchestrating automated pipelines, you often need responses formatted strictly as machine-readable JSON rather than freeform text. Coms-net provides first-class schema validation via the `response_schema` parameter.

### Defining a Schema
Suppose you want an agent to analyze a git diff and return an array of security findings:

```json
// Tool Call: coms_net_send
{
  "target": "security-auditor",
  "prompt": "Analyze the git diff for commit HEAD~1 for SQL injection or path traversal vulnerabilities.",
  "response_schema": {
    "type": "object",
    "properties": {
      "hasVulnerabilities": { "type": "boolean" },
      "findings": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "severity": { "type": "string", "enum": ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
            "file": { "type": "string" },
            "line": { "type": "number" },
            "description": { "type": "string" }
          },
          "required": ["severity", "file", "line", "description"]
        }
      }
    },
    "required": ["hasVulnerabilities", "findings"]
  }
}
```

### How the Bridge Validates the Response
When the responder finishes its turn, `validateResponseSchema` processes the assistant output:
1. **Direct JSON**: If the model outputs raw JSON (`{ "hasVulnerabilities": false, ... }`), it is parsed directly.
2. **Markdown Codeblock Extraction**: If the model encloses its answer in markdown fences (e.g. ```` ```json { ... } ``` ````), the parser automatically strips the codeblock boundaries and parses the inner JSON.
3. **Validation Failure**: If the model output cannot be parsed into valid JSON, the response payload is rejected, and an error object (`{ "error": "response not valid JSON" }`) is returned to the caller.

### Retrieving Structured Output
When you call `coms_net_await`, the `response` property contains the parsed JSON object:
```json
{
  "status": "complete",
  "response": {
    "hasVulnerabilities": false,
    "findings": []
  }
}
```

---

## Tutorial 3: Multi-Turn Dialogues & Conversation State

By default, coms-net prompts are isolated turns. However, when coordinating an iterative task (e.g. pair debugging or multi-step design), you should maintain state using `conversation_id`.

### Initiating a Stateful Dialogue
1. Generate or define a unique `conversation_id` (e.g. `conv-refactor-auth-v1`).
2. Include the `conversation_id` in your first dispatch:
   ```json
   // Turn 1
   coms_net_send({
     "target": "coder-agent",
     "prompt": "Step 1: Inspect src/auth.ts and propose an interface for OIDC tokens.",
     "conversation_id": "conv-refactor-auth-v1"
   })
   ```
3. Await the response with `coms_net_await`.
4. Send the follow-up prompt reusing the exact same `conversation_id`:
   ```json
   // Turn 2
   coms_net_send({
     "target": "coder-agent",
     "prompt": "Step 2: Great. Now implement that interface using node:crypto.",
     "conversation_id": "conv-refactor-auth-v1"
   })
   ```

### What Happens Inside the Responder Bridge
When the responder bridge receives a prompt containing a `conversation_id`, it passes `--conversation conv-refactor-auth-v1` to `agy -p`. Antigravity resumes the conversation history, retaining full memory of previous turns, code edits, and context.

---

## Tutorial 4: Error Handling & Network Resilience

### 1. Handling Timeouts
If a complex task takes longer than expected:
- `coms_net_await` returns:
  ```json
  {
    "status": "timeout",
    "error": "timeout",
    "isError": true
  }
  ```
- **Recovery Action**: Check whether the task is still running using `coms_net_get(msg_id)`.
  - If `status: "delivered"`, the agent is still working. You can call `coms_net_await(msg_id, timeout_ms=120000)` to wait longer.
  - Do not immediately dispatch duplicate tasks to the peer.

### 2. Handling Missing or Ambiguous Peers
- If an agent name does not exist or multiple agents share the name:
  `coms_net_send` throws `TargetNotFoundError` or `AmbiguousTargetError`.
- **Recovery Action**: Call `coms_net_list()` to view live peer records. Use the target's exact 26-character `session_id` (e.g. `01J7ABCDEF...`) as the `target` parameter instead of its name.

### 3. Automatic Hub Reconnection & Heartbeat Healing
- If the coms-net hub restarts or network connectivity blips:
  - The SSE event listener emits `sse_disconnected` and enters exponential backoff (500ms initial, doubling up to 10s with randomized jitter).
  - If the hub forgot the session (returning `404 agent_not_found` on heartbeat), the `AgentLifecycle` manager automatically triggers re-registration (`reRegister()`), adopting the restored session transparently.

---

## Tutorial 5: Anti-Looping Discipline & Hop Limits

Cross-agent communication patterns introduce the risk of infinite message loops if agents attempt to reply by initiating new outbound messages. Antigravity Coms-Net enforces strict protocol rules to eliminate this risk.

### The Mechanics of an Infinite Ping-Pong Loop
Consider two agents, Agent A and Agent B:
1. Agent A calls `coms_net_send(target: "B", prompt: "Hello B")`.
2. Agent B receives the prompt. **Mistake**: Agent B calls `coms_net_send(target: "A", prompt: "Hello A, I received your message")`.
3. Agent A receives Agent B's message as an *inbound prompt*. Agent A calls `coms_net_send(target: "B", ...)` to answer.
4. **Result**: Both agents continuously trigger new turns, exhausting model tokens and quota.

### The Golden Rule for Responders
> **When answering an inbound message, write your answer as your normal assistant text.**  
> **NEVER call `coms_net_send`, `coms_net_await`, or `coms_net_get` to reply.**

The Antigravity bridge automatically captures the text from your assistant response and submits it to `POST /v1/messages/:msg_id/response`.

### Prompt Envelope Safeguard
The bridge daemon enforces this rule by wrapping every inbound prompt with an explicit warning banner:
```text
[inbound coms-net message from sender_name @ /path]
[reply by writing a normal assistant message — your turn output is auto-returned to sender_name.
DO NOT call coms_net_send/coms_net_await/coms_net_get to reply; that creates a ping-pong loop.
msg_id 01J7AB... belongs to sender_name's outbound, not yours.]

<Original Prompt Text>
```

### Hop Limit Circuit Breaker (`MAX_HOPS = 5`)
Even in legitimate delegation scenarios (Agent A delegates to Agent B, which delegates to Agent C), chains must not grow without bound.
- Every message payload contains a `hops` counter.
- When an agent delegates a subtask while processing an inbound turn, `hops` is incremented (`hops = parent_hops + 1`).
- If `hops >= 5`, `coms_net_send` throws `HopLimitExceededError` and immediately halts dispatch.
