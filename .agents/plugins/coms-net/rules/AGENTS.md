# Coms-Net Multi-Agent Collaboration Rules

You are connected to the **coms-net multi-agent mesh network**, enabling collaboration between Antigravity agents, Pi agents, and specialized automated workers across projects.

Follow these rules when interacting with peer agents or responding to inbound network messages.

---

## 1. Peer Discovery & Agent Selection

1. **Discover Peers Before Dispatching**: Always invoke `coms_net_list` before delegating tasks or sending inquiries. Do not guess or assume agent names or availability.
2. **Examine Metadata**: Review peer metadata returned by `coms_net_list`:
   - `name`: The unique agent identifier within the project namespace.
   - `purpose`: The specialized capability, expertise, or role of the agent.
   - `model`: The underlying LLM powering the agent (e.g. `claude-sonnet-4-6`, `gemini-3.7-flash`).
   - `status`: Only delegate tasks to agents with `status: "online"`. Avoid targeting agents marked `stale` or `offline`.
3. **Task Matching**: Route subtasks to agents whose declared `purpose` and model capabilities best match the workload (e.g. route code reviews to review specialists, deep search to research agents).

---

## 2. Outbound Task Delegation (`coms_net_send` & `coms_net_await`)

1. **Self-Contained Prompts**: Provide complete, clear context in the `prompt` parameter of `coms_net_send`. Peer agents run in separate process spaces or remote environments; they do not share your in-memory conversation history or temporary variables unless explicitly provided. Include:
   - Specific objectives and constraints.
   - File paths (use absolute or repository-relative paths).
   - Relevant code snippets or error logs.
   - Expected output format.
2. **Structured Outputs**: When you require programmatic results (e.g. JSON test matrices, lint findings), supply a valid JSON Schema in `response_schema`.
3. **Response Retrieval Workflow**:
   - **Primary (Blocking)**: Call `coms_net_await(msg_id, timeout_ms)` immediately after `coms_net_send` to wait for the responder's result. Use a reasonable timeout (e.g., 60,000 ms to 180,000 ms depending on task complexity).
   - **Secondary (Polling)**: Use `coms_net_get(msg_id)` only if you need to perform local computing or filesystem modifications while the peer works concurrently.
4. **Stateful Dialogues**: When engaging in multi-turn exchanges with the same peer, preserve and reuse the returned or initial `conversation_id`.

---

## 3. STRICT ANTI-LOOPING RULES (CRITICAL PROTOCOL INVARIANT)

Failure to observe anti-looping rules will trigger recursive agent execution loops, quota exhaustion, and message cascading failure across the network.

1. **NEVER Call `coms_net_send` to Reply to Inbound Messages**:
   - When an inbound prompt is delivered to you, it will be prefixed with:
     `[inbound coms-net message from <sender_name> @ <sender_cwd>]`
     `[reply by writing a normal assistant message — your turn output is auto-returned to <sender_name>...]`
   - You are the **RESPONDER**, not the initiator.
   - **Formulate your answer directly in your assistant message text.** The Antigravity bridge turn executor automatically captures your final turn output and submits it back to the hub via `POST /v1/messages/:msg_id/response`.
   - Calling `coms_net_send` in response to an inbound prompt initiates a **NEW, SEPARATE outbound message**, triggering an infinite ping-pong loop between agents.
2. **DO NOT Await or Poll Inbound Message IDs**:
   - The `msg_id` referenced in an inbound prompt belongs to the *sender's* outbound message record.
   - Calling `coms_net_await` or `coms_net_get` on an inbound `msg_id` will deadlock or fail.
3. **Hop Limit Awareness**:
   - The coms-net mesh strictly enforces a maximum hop limit of 5 (`MAX_HOPS = 5`).
   - If an agent delegates a sub-subtask, `hops` is incremented. At `hops >= 5`, message dispatch is aborted with `HopLimitExceededError`.
   - Never chain message delegations indefinitely.

---

## 4. Error Handling & Network Resilience

1. **Missing or Ambiguous Target**: If `coms_net_send` returns `TargetNotFoundError` or `AmbiguousTargetError`, refresh peer presence with `coms_net_list` and use the peer's exact 26-character `session_id` instead of its name.
2. **Timeout Handling**: If `coms_net_await` returns `status: "timeout"`, check with `coms_net_get`. If still pending, either retry `coms_net_await` with a longer timeout or report the delay to the user. Do not re-send duplicate prompts immediately.
3. **Token Privacy**: Bearer tokens and authorization secrets must never be transmitted in prompts or messages.
