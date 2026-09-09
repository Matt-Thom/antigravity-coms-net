/**
 * tests/integration/bridge-daemon.test.ts
 *
 * End-to-end integration tests for BridgeDaemon coordinating lifecycle,
 * SSE streaming, turn execution, schema validation, and tools.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { MockHub } from "../mocks/mock-hub.ts";
import { ComsNetClient } from "../../src/protocol/client.ts";
import { BridgeDaemon } from "../../src/bridge/daemon.ts";
import { MockTurnExecutor } from "../../src/bridge/turn-executor.ts";
import { HopLimitExceededError } from "../../src/protocol/errors.ts";

describe("BridgeDaemon Integration Tests", () => {
  let hub: MockHub;
  let client: ComsNetClient;
  let senderClient: ComsNetClient;

  before(async () => {
    hub = new MockHub();
    await hub.start();
    client = new ComsNetClient({
      baseUrl: hub.baseUrl,
      authToken: hub.token,
      project: "daemon-tests",
    });
    senderClient = new ComsNetClient({
      baseUrl: hub.baseUrl,
      authToken: hub.token,
      project: "daemon-tests",
    });
  });

  after(async () => {
    await hub.stop();
  });

  it("D1: should start daemon, register with hub, connect SSE, and maintain heartbeat", async () => {
    const daemon = new BridgeDaemon({
      client,
      name: "daemon-alpha",
      purpose: "Coordinator testing",
      turnExecutor: new MockTurnExecutor({ defaultResponse: "Ready" }),
    });

    let sseConnected = false;
    daemon.on("sse_connected", () => {
      sseConnected = true;
    });

    const card = await daemon.start();
    assert.strictEqual(daemon.status, "running");
    assert.ok(card.session_id);
    assert.strictEqual(card.name, "daemon-alpha");
    assert.strictEqual(card.project, "daemon-tests");

    // Wait briefly for SSE stream to establish
    for (let i = 0; i < 20; i++) {
      if (sseConnected) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.strictEqual(sseConnected, true, "SSE stream must be connected");

    // Check registry presence in hub
    const project = hub.getProject("daemon-tests");
    assert.ok(project.agents.has(card.session_id));

    await daemon.stop();
    assert.strictEqual(daemon.status, "stopped");
    assert.strictEqual(project.agents.has(card.session_id), false, "Must unregister on stop");
  });

  it("D2: should receive inbound prompt over SSE, execute turn, and submit response to hub", async () => {
    // 1. Register sender agent
    const senderReg = await senderClient.registerAgent({
      project: "daemon-tests",
      session_id: "01JMSENDER00000000000000001",
      name: "sender-alice",
    });
    assert.ok(senderReg.ok);

    // 2. Start daemon with custom mock turn executor
    const mockExecutor = new MockTurnExecutor();
    mockExecutor.setHandler(async (event) => {
      return {
        response: `Processed: ${event.prompt}`,
        duration_seconds: 0.1,
      };
    });

    const daemon = new BridgeDaemon({
      client,
      name: "daemon-worker",
      turnExecutor: mockExecutor,
    });

    let promptReceived = false;
    let turnCompleted = false;
    daemon.on("prompt_received", () => { promptReceived = true; });
    daemon.on("turn_completed", () => { turnCompleted = true; });

    await daemon.start();
    const daemonId = daemon.getIdentity()!;

    // 3. Sender sends prompt to daemon
    const sendResult = await senderClient.sendMessage({
      project: "daemon-tests",
      sender_session: senderReg.agent.session_id,
      target: daemonId.name,
      prompt: "Review architecture diagram",
    });
    assert.ok(sendResult.msg_id);

    // 4. Await response via HTTP await long-poll
    const awaitRes = await senderClient.awaitMessage(sendResult.msg_id, {
      project: "daemon-tests",
      timeout_ms: 3000,
    });

    assert.strictEqual(awaitRes.status, "complete");
    assert.strictEqual(awaitRes.response, "Processed: Review architecture diagram");
    assert.strictEqual(promptReceived, true);

    for (let i = 0; i < 20; i++) {
      if (turnCompleted) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.strictEqual(turnCompleted, true);

    await daemon.stop();
    await senderClient.deleteAgent(senderReg.agent.session_id, { project: "daemon-tests" });
  });

  it("D3: should enforce schema validation (markdown JSON and invalid fallback)", async () => {
    const senderReg = await senderClient.registerAgent({
      project: "daemon-tests",
      session_id: "01JMSENDER00000000000000002",
      name: "sender-schema",
    });

    const mockExecutor = new MockTurnExecutor();
    const daemon = new BridgeDaemon({
      client,
      name: "daemon-validator",
      turnExecutor: mockExecutor,
    });
    await daemon.start();
    const daemonId = daemon.getIdentity()!;

    // Case 1: Valid Markdown codeblock JSON
    mockExecutor.setHandler(async () => ({
      response: "```json\n{\"status\": \"APPROVED\", \"score\": 95}\n```",
    }));

    const send1 = await senderClient.sendMessage({
      project: "daemon-tests",
      sender_session: senderReg.agent.session_id,
      target: daemonId.name,
      prompt: "Validate security compliance",
      response_schema: { type: "object" },
    });

    const res1 = await senderClient.awaitMessage(send1.msg_id, {
      project: "daemon-tests",
      timeout_ms: 3000,
    });
    assert.strictEqual(res1.status, "complete");
    assert.deepStrictEqual(res1.response, { status: "APPROVED", score: 95 });

    // Case 2: Invalid non-JSON response fallback
    mockExecutor.setHandler(async () => ({
      response: "Sorry, I cannot produce JSON right now.",
    }));

    const send2 = await senderClient.sendMessage({
      project: "daemon-tests",
      sender_session: senderReg.agent.session_id,
      target: daemonId.name,
      prompt: "Extract tabular numbers",
      response_schema: { type: "object" },
    });

    const res2 = await senderClient.awaitMessage(send2.msg_id, {
      project: "daemon-tests",
      timeout_ms: 3000,
    });
    assert.strictEqual(res2.status, "error");
    assert.strictEqual(res2.response, null);
    assert.strictEqual(res2.error, "response not valid JSON");

    await daemon.stop();
    await senderClient.deleteAgent(senderReg.agent.session_id, { project: "daemon-tests" });
  });

  it("D4: should process inbound turns in sequential FIFO order and report queue depth", async () => {
    const senderReg = await senderClient.registerAgent({
      project: "daemon-tests",
      session_id: "01JMSENDER00000000000000003",
      name: "sender-fifo",
    });

    const executionOrder: string[] = [];
    const mockExecutor = new MockTurnExecutor();
    mockExecutor.setHandler(async (event) => {
      executionOrder.push(event.prompt);
      await new Promise((r) => setTimeout(r, 40));
      return { response: `Done: ${event.prompt}` };
    });

    const daemon = new BridgeDaemon({
      client,
      name: "daemon-fifo",
      turnExecutor: mockExecutor,
      maxConcurrentTurns: 1,
    });
    await daemon.start();
    const daemonId = daemon.getIdentity()!;

    // Send 3 messages concurrently
    const [p1, p2, p3] = await Promise.all([
      senderClient.sendMessage({
        project: "daemon-tests",
        sender_session: senderReg.agent.session_id,
        target: daemonId.name,
        prompt: "Task 1",
      }),
      senderClient.sendMessage({
        project: "daemon-tests",
        sender_session: senderReg.agent.session_id,
        target: daemonId.name,
        prompt: "Task 2",
      }),
      senderClient.sendMessage({
        project: "daemon-tests",
        sender_session: senderReg.agent.session_id,
        target: daemonId.name,
        prompt: "Task 3",
      }),
    ]);

    // Await all replies
    const [res1, res2, res3] = await Promise.all([
      senderClient.awaitMessage(p1.msg_id, { project: "daemon-tests", timeout_ms: 4000 }),
      senderClient.awaitMessage(p2.msg_id, { project: "daemon-tests", timeout_ms: 4000 }),
      senderClient.awaitMessage(p3.msg_id, { project: "daemon-tests", timeout_ms: 4000 }),
    ]);

    assert.strictEqual(res1.status, "complete");
    assert.strictEqual(res2.status, "complete");
    assert.strictEqual(res3.status, "complete");

    // Verify sequential FIFO execution order
    assert.deepStrictEqual(executionOrder, ["Task 1", "Task 2", "Task 3"]);
    for (let i = 0; i < 20; i++) {
      if (daemon.getInboundQueueSize() === 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.strictEqual(daemon.getInboundQueueSize(), 0);

    await daemon.stop();
    await senderClient.deleteAgent(senderReg.agent.session_id, { project: "daemon-tests" });
  });

  it("D5: should enforce anti-looping hop limits during tool sub-delegation", async () => {
    const senderReg = await senderClient.registerAgent({
      project: "daemon-tests",
      session_id: "01JMSENDER00000000000000004",
      name: "sender-hops",
    });

    const peerReg = await senderClient.registerAgent({
      project: "daemon-tests",
      session_id: "01JMPEER000000000000000001",
      name: "peer-target",
    });

    const mockExecutor = new MockTurnExecutor();
    const daemon = new BridgeDaemon({
      client,
      name: "daemon-hops",
      turnExecutor: mockExecutor,
    });
    await daemon.start();
    const daemonId = daemon.getIdentity()!;

    let observedHopsInSubDelegation = -1;
    let hopErrorThrown = false;

    mockExecutor.setHandler(async (event) => {
      const tools = daemon.getTools();

      if (event.prompt === "sub-delegate-ok") {
        // Legitimate delegation: should inherit hops + 1
        const result = await tools.send({
          target: "peer-target",
          prompt: "Please review subtask",
        });
        observedHopsInSubDelegation = result.details.hops;
        return { response: "Subtask delegated" };
      }

      if (event.prompt === "sub-delegate-exceeded") {
        try {
          // With inbound hops = 4, sub-delegating hops = 5 will exceed MAX_HOPS (5)
          await tools.send({
            target: "peer-target",
            prompt: "Excessive hop delegation",
          });
        } catch (e) {
          if (e instanceof HopLimitExceededError) {
            hopErrorThrown = true;
          }
          throw e;
        }
      }

      return { response: "ok" };
    });

    // Test case 1: Inbound hops = 2 -> sub-delegation hops = 3
    const s1 = await senderClient.sendMessage({
      project: "daemon-tests",
      sender_session: senderReg.agent.session_id,
      target: daemonId.name,
      prompt: "sub-delegate-ok",
      hops: 2,
    });
    const r1 = await senderClient.awaitMessage(s1.msg_id, { project: "daemon-tests", timeout_ms: 3000 });
    assert.strictEqual(r1.status, "complete");
    assert.strictEqual(observedHopsInSubDelegation, 3);

    // Test case 2: Inbound hops = 4 -> sub-delegation hops = 5 throws HopLimitExceededError
    const s2 = await senderClient.sendMessage({
      project: "daemon-tests",
      sender_session: senderReg.agent.session_id,
      target: daemonId.name,
      prompt: "sub-delegate-exceeded",
      hops: 4,
    });
    const r2 = await senderClient.awaitMessage(s2.msg_id, { project: "daemon-tests", timeout_ms: 3000 });
    assert.strictEqual(r2.status, "error");
    assert.strictEqual(hopErrorThrown, true);

    await daemon.stop();
    await senderClient.deleteAgent(senderReg.agent.session_id, { project: "daemon-tests" });
    await senderClient.deleteAgent(peerReg.agent.session_id, { project: "daemon-tests" });
  });

  it("D6: should resolve pendingReplies immediately when SSE response arrives", async () => {
    const peerReg = await senderClient.registerAgent({
      project: "daemon-tests",
      session_id: "01JMPEER000000000000000002",
      name: "peer-replier",
    });

    const daemon = new BridgeDaemon({
      client,
      name: "daemon-client",
      turnExecutor: new MockTurnExecutor(),
    });
    await daemon.start();

    const tools = daemon.getTools();

    // Daemon sends message to peer
    const sent = await tools.send({
      target: "peer-replier",
      prompt: "Calculate checksum",
    });
    assert.ok(sent.details.msg_id);

    // Start awaiting reply
    const awaitPromise = tools.await({ msg_id: sent.details.msg_id, timeout_ms: 3000 });

    // Peer responds via hub
    await senderClient.submitResponse(sent.details.msg_id, {
      project: "daemon-tests",
      responder_session: peerReg.agent.session_id,
      response: "Checksum: 0xDEADBEEF",
    });

    const reply = await awaitPromise;
    assert.strictEqual(reply.details.status, "complete");
    assert.strictEqual(reply.details.response, "Checksum: 0xDEADBEEF");

    await daemon.stop();
    await senderClient.deleteAgent(peerReg.agent.session_id, { project: "daemon-tests" });
  });
});
