/**
 * Tier 3: Pairwise Cross-Feature & Concurrency Verification
 * Exercises concurrent multi-sender traffic, bidirectional messaging,
 * 3-way await race resolution, multi-hop relay chaining, and mass peer broadcasts.
 */

import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { MockHub, generateUlid } from "../mocks/mock-hub.ts";
import { TestClient } from "../mocks/test-client.ts";

describe("Tier 3: Pairwise Cross-Feature & Concurrency", () => {
  let hub: MockHub;
  let client: TestClient;

  before(async () => {
    hub = new MockHub({ maxInbox: 50 });
    await hub.start();
    client = new TestClient(hub.baseUrl, hub.token);
  });

  after(async () => {
    await hub.stop();
  });

  it("T3.1: Concurrent Multi-Sender Fan-In to single receiver", async () => {
    const project = "fan-in-" + generateUlid();
    const receiverSid = generateUlid();
    await client.register({ session_id: receiverSid, name: "receiver", project });

    const receiverSse = client.connectSse(receiverSid, project);
    await receiverSse.waitForEvent("hello");

    const senderCount = 5;
    const senders: string[] = [];
    for (let i = 0; i < senderCount; i++) {
      const sid = generateUlid();
      senders.push(sid);
      await client.register({ session_id: sid, name: `sender-${i}`, project });
    }

    // Collect inbound prompt events
    const receivedPrompts: any[] = [];
    receiverSse.on("prompt", (data) => {
      receivedPrompts.push(data);
    });

    // Fire all sends concurrently
    const sendPromises = senders.map((sid, idx) =>
      client.sendMessage({
        project,
        sender_session: sid,
        target_session: receiverSid,
        prompt: `Concurrent prompt ${idx}`,
      })
    );

    const sendResults = await Promise.all(sendPromises);
    for (const res of sendResults) {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.status, "delivered");
    }

    // Wait until all prompts received
    const timeout = Date.now() + 5000;
    while (receivedPrompts.length < senderCount && Date.now() < timeout) {
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.strictEqual(receivedPrompts.length, senderCount, "Receiver must receive all concurrent prompts");
    const uniqueMsgIds = new Set(receivedPrompts.map((p) => p.msg_id));
    assert.strictEqual(uniqueMsgIds.size, senderCount, "All msg_ids must be unique");

    receiverSse.close();
  });

  it("T3.2: High-Throughput Bidirectional Ping-Pong Messaging", async () => {
    const project = "ping-pong-" + generateUlid();
    const agentASid = generateUlid();
    const agentBSid = generateUlid();

    await client.register({ session_id: agentASid, name: "agent-a", project });
    await client.register({ session_id: agentBSid, name: "agent-b", project });

    const sseA = client.connectSse(agentASid, project);
    const sseB = client.connectSse(agentBSid, project);
    await Promise.all([sseA.waitForEvent("hello"), sseB.waitForEvent("hello")]);

    const rounds = 5;
    for (let round = 1; round <= rounds; round++) {
      // Agent A sends to Agent B
      const sendA = await client.sendMessage({
        project,
        sender_session: agentASid,
        target_session: agentBSid,
        prompt: `Ping round ${round}`,
      });
      assert.strictEqual(sendA.body.status, "delivered");

      const promptB = await sseB.waitForEvent("prompt");
      assert.strictEqual(promptB.prompt, `Ping round ${round}`);

      // Agent B replies
      await client.submitResponse(promptB.msg_id, {
        project,
        responder_session: agentBSid,
        response: `Pong round ${round}`,
      });

      const replyA = await sseA.waitForEvent("response");
      assert.strictEqual(replyA.response, `Pong round ${round}`);
    }

    sseA.close();
    sseB.close();
  });

  it("T3.3: 3-Way Await Race Condition Resolution (SSE vs HTTP Await vs Timeout)", async () => {
    const project = "race-" + generateUlid();
    const senderSid = generateUlid();
    const targetSid = generateUlid();

    await client.register({ session_id: senderSid, name: "race-sender", project });
    await client.register({ session_id: targetSid, name: "race-target", project });

    const sseSender = client.connectSse(senderSid, project);
    await sseSender.waitForEvent("hello");

    const sendRes = await client.sendMessage({
      project,
      sender_session: senderSid,
      target_session: targetSid,
      prompt: "Race test prompt",
    });
    const msgId = sendRes.body.msg_id;

    // 1. SSE response promise
    const ssePromise = sseSender.waitForEvent("response", 5000);
    // 2. HTTP await long-poll promise
    const httpPromise = client.awaitMessage(msgId, 5000);

    // Target submits response after 50ms
    setTimeout(async () => {
      await client.submitResponse(msgId, {
        project,
        responder_session: targetSid,
        response: "Resolved in race",
      });
    }, 50);

    // Both should resolve cleanly with identical payload
    const [sseResult, httpResult] = await Promise.all([ssePromise, httpPromise]);

    assert.strictEqual(sseResult.msg_id, msgId);
    assert.strictEqual(sseResult.response, "Resolved in race");
    assert.strictEqual(sseResult.status, "complete");

    assert.strictEqual(httpResult.status, 200);
    assert.strictEqual(httpResult.body.msg_id, msgId);
    assert.strictEqual(httpResult.body.response, "Resolved in race");
    assert.strictEqual(httpResult.body.status, "complete");

    sseSender.close();
  });

  it("T3.4: Concurrent Re-registration & Event Flow (Upsert during active stream)", async () => {
    const project = "upsert-flow-" + generateUlid();
    const sid = generateUlid();

    const initialReg = await client.register({ session_id: sid, name: "active-agent", project });
    assert.strictEqual(initialReg.status, 200);

    const sse = client.connectSse(sid, project);
    await sse.waitForEvent("hello");

    // While stream is open, re-register with updated model
    const reReg = await client.register({
      session_id: sid,
      name: "active-agent",
      model: "claude-opus-4-7",
      project,
    });
    assert.strictEqual(reReg.status, 200);
    assert.strictEqual(reReg.body.agent.model, "claude-opus-4-7");

    // Verify stream is still alive and can receive a ping
    hub.emitKeepalive();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(sse.keepalives.length > 0, "Stream must remain open and receive keepalives");

    sse.close();
  });

  it("T3.5: Cross-Agent Message Chaining (3-Hop Relay: A -> B -> C -> B -> A)", async () => {
    const project = "chain-" + generateUlid();
    const sidA = generateUlid();
    const sidB = generateUlid();
    const sidC = generateUlid();

    await client.register({ session_id: sidA, name: "agent-a", project });
    await client.register({ session_id: sidB, name: "agent-b", project });
    await client.register({ session_id: sidC, name: "agent-c", project });

    const sseA = client.connectSse(sidA, project);
    const sseB = client.connectSse(sidB, project);
    const sseC = client.connectSse(sidC, project);
    await Promise.all([
      sseA.waitForEvent("hello"),
      sseB.waitForEvent("hello"),
      sseC.waitForEvent("hello"),
    ]);

    // Hop 0: Agent A prompts Agent B
    const sendAtoB = await client.sendMessage({
      project,
      sender_session: sidA,
      target_session: sidB,
      prompt: "Please delegate analysis to Agent C",
      hops: 0,
    });
    assert.strictEqual(sendAtoB.body.status, "delivered");

    const promptAtB = await sseB.waitForEvent("prompt");
    assert.strictEqual(promptAtB.hops, 0);

    // Hop 1: Agent B forwards sub-task to Agent C (hops: 1)
    const sendBtoC = await client.sendMessage({
      project,
      sender_session: sidB,
      target_session: sidC,
      prompt: "Execute sub-analysis",
      hops: promptAtB.hops + 1,
    });
    assert.strictEqual(sendBtoC.body.status, "delivered");

    const promptAtC = await sseC.waitForEvent("prompt");
    assert.strictEqual(promptAtC.hops, 1);

    // Agent C responds to Agent B
    await client.submitResponse(promptAtC.msg_id, {
      project,
      responder_session: sidC,
      response: "Sub-analysis completed by C",
    });

    const replyAtB = await sseB.waitForEvent("response");
    assert.strictEqual(replyAtB.response, "Sub-analysis completed by C");

    // Agent B completes response to Agent A
    await client.submitResponse(promptAtB.msg_id, {
      project,
      responder_session: sidB,
      response: `Final result incorporating: ${replyAtB.response}`,
    });

    const replyAtA = await sseA.waitForEvent("response");
    assert.strictEqual(replyAtA.response, "Final result incorporating: Sub-analysis completed by C");

    sseA.close();
    sseB.close();
    sseC.close();
  });

  it("T3.6: Mass Peer Registration & Simultaneous Metric Update Fan-Out", async () => {
    const project = "mass-" + generateUlid();
    const observerSid = generateUlid();
    await client.register({ session_id: observerSid, name: "observer", project });

    const observerSse = client.connectSse(observerSid, project);
    await observerSse.waitForEvent("hello");

    const peerCount = 10;
    const joinedEvents: any[] = [];
    observerSse.on("agent_joined", (d) => joinedEvents.push(d));

    // Register 10 peers in parallel
    const peerSids = Array.from({ length: peerCount }, () => generateUlid());
    await Promise.all(
      peerSids.map((sid, idx) =>
        client.register({ session_id: sid, name: `mass-peer-${idx}`, project })
      )
    );

    // Wait for all 10 agent_joined events
    const timeout = Date.now() + 5000;
    while (joinedEvents.length < peerCount && Date.now() < timeout) {
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.strictEqual(joinedEvents.length, peerCount, "Observer must receive all agent_joined events");

    // Verify peer list has all 10 peers + observer = 11 agents
    const listRes = await client.listAgents({ project });
    assert.strictEqual(listRes.body.agents.length, peerCount + 1);

    observerSse.close();
  });
});
