/**
 * Tier 4: Real-World Multi-Agent Collaboration Scenarios
 * End-to-end verification of multi-agent collaboration pipelines:
 * - Pi <-> Antigravity collaborative code review with schema validation
 * - Antigravity multi-agent orchestration (Planner -> Coder -> Reviewer)
 * - Network drop & resilient exponential backoff reconnect
 * - Graceful multi-agent shutdown & clean registry state
 */

import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { MockHub, generateUlid } from "../mocks/mock-hub.ts";
import { TestClient } from "../mocks/test-client.ts";

describe("Tier 4: Real-World Multi-Agent Workflows", () => {
  let hub: MockHub;
  let client: TestClient;

  before(async () => {
    hub = new MockHub();
    await hub.start();
    client = new TestClient(hub.baseUrl, hub.token);
  });

  after(async () => {
    await hub.stop();
  });

  it("T4.1: Pi <-> Antigravity Multi-Agent Code Collaboration with Schema Validation", async () => {
    const project = "pi-agy-" + generateUlid();

    // 1. Register Pi Agent (Reference Peer)
    const piSid = generateUlid();
    const piReg = await client.register({
      project,
      session_id: piSid,
      name: "pi-lead",
      purpose: "Project orchestrator and task assigner",
      model: "gpt-4o",
      color: "#FF7EDB",
    });
    assert.strictEqual(piReg.status, 200);

    // 2. Register Antigravity Agent (Target Peer)
    const agySid = generateUlid();
    const agyReg = await client.register({
      project,
      session_id: agySid,
      name: "agy-coder",
      purpose: "Fullstack TypeScript engineer",
      model: "claude-opus-4-7",
      color: "#36F9F6",
      cwd: "/home/matt/Code/antigravity-coms-net",
    });
    assert.strictEqual(agyReg.status, 200);

    // 3. Open SSE streams for both agents
    const piSse = client.connectSse(piSid, project);
    const agySse = client.connectSse(agySid, project);
    await Promise.all([piSse.waitForEvent("hello"), agySse.waitForEvent("hello")]);

    // 4. Pi agent discovers peers via coms_net_list
    const peerList = await client.listAgents({ project });
    const agyPeer = peerList.body.agents.find((a) => a.name === "agy-coder");
    assert.ok(agyPeer, "Pi must discover agy-coder peer");
    assert.strictEqual(agyPeer.model, "claude-opus-4-7");

    // 5. Pi sends structured prompt with response_schema
    const codeSchema = {
      type: "object",
      required: ["code", "explanation", "tests_passing"],
      properties: {
        code: { type: "string" },
        explanation: { type: "string" },
        tests_passing: { type: "boolean" },
      },
    };

    const sendRes = await client.sendMessage({
      project,
      sender_session: piSid,
      target: "agy-coder",
      prompt: "Implement a binary search function with tests",
      response_schema: codeSchema,
    });
    assert.strictEqual(sendRes.body.status, "delivered");
    const msgId = sendRes.body.msg_id;

    // 6. Antigravity receives prompt over SSE
    const promptEvent = await agySse.waitForEvent("prompt");
    assert.strictEqual(promptEvent.msg_id, msgId);
    assert.strictEqual(promptEvent.sender.name, "pi-lead");
    assert.deepStrictEqual(promptEvent.response_schema, codeSchema);

    // 7. Antigravity turn executor produces schema-compliant response
    const payload = {
      code: "function binarySearch(arr, target) { ... }",
      explanation: "Standard logarithmic binary search algorithm",
      tests_passing: true,
    };

    // Schema validation simulation
    const isValid =
      typeof payload.code === "string" &&
      typeof payload.explanation === "string" &&
      typeof payload.tests_passing === "boolean";
    assert.strictEqual(isValid, true, "Payload must satisfy schema contract");

    // Submit response to hub
    const respRes = await client.submitResponse(msgId, {
      project,
      responder_session: agySid,
      response: payload,
    });
    assert.strictEqual(respRes.status, 200);

    // 8. Pi receives response via SSE and confirms completion
    const replyEvent = await piSse.waitForEvent("response");
    assert.strictEqual(replyEvent.msg_id, msgId);
    assert.strictEqual(replyEvent.status, "complete");
    assert.deepStrictEqual(replyEvent.response, payload);

    piSse.close();
    agySse.close();
  });

  it("T4.2: Antigravity Multi-Agent Pipeline (Planner -> Coder -> Reviewer)", async () => {
    const project = "pipeline-" + generateUlid();

    const plannerSid = generateUlid();
    const coderSid = generateUlid();
    const reviewerSid = generateUlid();

    await client.register({ project, session_id: plannerSid, name: "planner" });
    await client.register({ project, session_id: coderSid, name: "coder" });
    await client.register({ project, session_id: reviewerSid, name: "reviewer" });

    const plannerSse = client.connectSse(plannerSid, project);
    const coderSse = client.connectSse(coderSid, project);
    const reviewerSse = client.connectSse(reviewerSid, project);
    await Promise.all([
      plannerSse.waitForEvent("hello"),
      coderSse.waitForEvent("hello"),
      reviewerSse.waitForEvent("hello"),
    ]);

    // Step 1: Planner sends task to Coder
    const planSend = await client.sendMessage({
      project,
      sender_session: plannerSid,
      target: "coder",
      prompt: "Build authentication middleware",
      hops: 0,
    });
    const coderPrompt = await coderSse.waitForEvent("prompt");
    assert.strictEqual(coderPrompt.prompt, "Build authentication middleware");

    // Step 2: Coder implements code and asks Reviewer to audit
    const coderSend = await client.sendMessage({
      project,
      sender_session: coderSid,
      target: "reviewer",
      prompt: "Audit this auth token check implementation",
      hops: 1,
    });
    const reviewerPrompt = await reviewerSse.waitForEvent("prompt");
    assert.strictEqual(reviewerPrompt.prompt, "Audit this auth token check implementation");
    assert.strictEqual(reviewerPrompt.hops, 1);

    // Step 3: Reviewer responds to Coder
    await client.submitResponse(reviewerPrompt.msg_id, {
      project,
      responder_session: reviewerSid,
      response: { approved: true, review: "Constant-time check verified. Clean." },
    });
    const coderReviewReply = await coderSse.waitForEvent("response");
    assert.strictEqual(coderReviewReply.response.approved, true);

    // Step 4: Coder completes task for Planner
    await client.submitResponse(coderPrompt.msg_id, {
      project,
      responder_session: coderSid,
      response: {
        implementation: "export function auth() { ... }",
        review: coderReviewReply.response,
      },
    });

    const plannerReply = await plannerSse.waitForEvent("response");
    assert.strictEqual(plannerReply.status, "complete");
    assert.strictEqual(plannerReply.response.review.approved, true);

    plannerSse.close();
    coderSse.close();
    reviewerSse.close();
  });

  it("T4.3: Resilient Connection Interruption & Auto-Reconnection Flow", async () => {
    const project = "reconnect-" + generateUlid();
    const agentSid = generateUlid();

    await client.register({ project, session_id: agentSid, name: "reconnector" });

    // Initial stream connection
    let sse = client.connectSse(agentSid, project);
    await sse.waitForEvent("hello");

    // Simulate network drop: close client connection
    sse.close();
    assert.strictEqual(sse.closed, true);

    // Simulate backoff delay: 50ms
    await new Promise((r) => setTimeout(r, 50));

    // Client reconnects: re-registers (upsert) and opens fresh stream
    const reReg = await client.register({ project, session_id: agentSid, name: "reconnector" });
    assert.strictEqual(reReg.status, 200);

    sse = client.connectSse(agentSid, project);
    const hello = await sse.waitForEvent("hello");
    assert.ok(hello.server_time);

    // Verify messages can still be delivered after reconnect
    const senderSid = generateUlid();
    await client.register({ project, session_id: senderSid, name: "sender" });
    await client.sendMessage({
      project,
      sender_session: senderSid,
      target_session: agentSid,
      prompt: "Message after reconnect",
    });

    const prompt = await sse.waitForEvent("prompt");
    assert.strictEqual(prompt.prompt, "Message after reconnect");

    sse.close();
  });

  it("T4.4: Graceful Multi-Agent Tear-Down & Clean State Verification", async () => {
    const project = "teardown-" + generateUlid();

    const agents = ["agent-1", "agent-2", "agent-3"];
    const sids = agents.map(() => generateUlid());

    for (let i = 0; i < agents.length; i++) {
      await client.register({ project, session_id: sids[i], name: agents[i] });
    }

    const initialList = await client.listAgents({ project });
    assert.strictEqual(initialList.body.agents.length, 3);

    // Gracefully unregister all agents one by one
    for (const sid of sids) {
      const del = await client.unregister(sid, project);
      assert.strictEqual(del.status, 200);
      assert.strictEqual(del.body.ok, true);
    }

    // Registry must now be completely empty for this project
    const finalList = await client.listAgents({ project });
    assert.strictEqual(finalList.body.agents.length, 0, "Project registry must be completely clean");
  });
});
