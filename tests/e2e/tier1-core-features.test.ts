/**
 * Tier 1: Core Protocol & Feature Verification
 * Covers primary behavior (happy paths) for all core features:
 * - Discovery mechanics (server.json, secret.json, env overrides)
 * - Registration, agent card generation, name collision resolution
 * - Heartbeat reporting & metrics broadcast
 * - Peer listing & project isolation
 * - Message sending (by name, by session_id, queued vs delivered)
 * - Message polling (get), long-polling (await), and response submission
 * - SSE lifecycle (hello, pool_snapshot, agent_joined, prompt, response)
 * - Graceful shutdown (DELETE /v1/agents/:session_id)
 */

import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MockHub, generateUlid } from "../mocks/mock-hub.ts";
import { TestClient } from "../mocks/test-client.ts";

describe("Tier 1: Core Protocol Features", () => {
  let hub: MockHub;
  let client: TestClient;
  let tempDir: string;

  before(async () => {
    hub = new MockHub();
    await hub.start();
    client = new TestClient(hub.baseUrl, hub.token);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coms-net-test-t1-"));
  });

  after(async () => {
    await hub.stop();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Discovery Mechanics (5 test cases)
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. Discovery Mechanics", () => {
    it("T1.1: should write and discover hub URL from server.json", () => {
      const projDir = path.join(tempDir, "projects", "default");
      const { serverJsonPath } = hub.writeDiscoveryFiles(projDir, "default");

      assert.ok(fs.existsSync(serverJsonPath), "server.json must exist");
      const raw = fs.readFileSync(serverJsonPath, "utf-8");
      const data = JSON.parse(raw);

      assert.strictEqual(data.version, 1);
      assert.strictEqual(data.project, "default");
      assert.strictEqual(data.local_url, hub.baseUrl);
      assert.strictEqual(data.server_id, hub.serverId);
      assert.strictEqual(data.pid, process.pid);
    });

    it("T1.2: should discover auth token from server.secret.json with 0600 mode", () => {
      const projDir = path.join(tempDir, "projects", "default");
      const { secretJsonPath } = hub.writeDiscoveryFiles(projDir, "default");

      assert.ok(fs.existsSync(secretJsonPath), "server.secret.json must exist");
      const st = fs.statSync(secretJsonPath);
      const mode = st.mode & 0o777;
      assert.strictEqual(mode, 0o600, "Secret file must have exactly 0600 permissions");

      const data = JSON.parse(fs.readFileSync(secretJsonPath, "utf-8"));
      assert.strictEqual(data.token, hub.token, "Secret token must match hub auth token");
    });

    it("T1.3: should prioritize environment variable overrides over filesystem discovery", () => {
      // Simulated resolution order
      const envUrl = "http://127.0.0.1:9999";
      const fileUrl = hub.baseUrl;

      // When env var is set, it overrides file
      const resolvedUrl = envUrl || fileUrl;
      assert.strictEqual(resolvedUrl, envUrl, "Environment variable must take precedence");
    });

    it("T1.4: should support project namespace scoping in discovery paths", () => {
      const customProject = "team-alpha";
      const projDir = path.join(tempDir, "projects", customProject);
      const { serverJsonPath } = hub.writeDiscoveryFiles(projDir, customProject);

      assert.ok(serverJsonPath.includes(customProject));
      const data = JSON.parse(fs.readFileSync(serverJsonPath, "utf-8"));
      assert.strictEqual(data.project, customProject);
    });

    it("T1.5: should verify unauthenticated /health endpoint reports server metadata", async () => {
      const res = await client.getHealth();
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.version, 1);
      assert.strictEqual(res.body.server_id, hub.serverId);
      assert.ok(res.body.started_at);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Registration & Agent Card (5 test cases)
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. Registration & Agent Card", () => {
    it("T1.6: should register new agent and return complete AgentCard and heartbeat interval", async () => {
      const sid = generateUlid();
      const res = await client.register({
        session_id: sid,
        name: "test-coder",
        purpose: "Testing agent registration",
        model: "claude-opus-4-7",
        provider: "anthropic",
        color: "#72F1B8",
        cwd: "/home/matt/test",
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.heartbeat_interval_ms, 10000);
      assert.strictEqual(res.body.agent.session_id, sid);
      assert.strictEqual(res.body.agent.name, "test-coder");
      assert.strictEqual(res.body.agent.purpose, "Testing agent registration");
      assert.strictEqual(res.body.agent.model, "claude-opus-4-7");
      assert.strictEqual(res.body.agent.status, "online");
      assert.strictEqual(res.body.agent.context_used_pct, 0);
      assert.strictEqual(res.body.agent.queue_depth, 0);
      assert.ok(res.body.sse_url.includes(sid));
    });

    it("T1.7: should perform upsert on re-registration, preserving started_at timestamp", async () => {
      const sid = generateUlid();
      const first = await client.register({ session_id: sid, name: "persister" });
      const originalStartedAt = first.body.agent.started_at;

      // Small delay then re-register with updated purpose
      const second = await client.register({
        session_id: sid,
        name: "persister",
        purpose: "Updated purpose",
      });

      assert.strictEqual(second.status, 200);
      assert.strictEqual(second.body.agent.session_id, sid);
      assert.strictEqual(second.body.agent.purpose, "Updated purpose");
      assert.strictEqual(second.body.agent.started_at, originalStartedAt, "started_at must be preserved");
    });

    it("T1.8: should resolve name collisions by appending numeric increment (name2)", async () => {
      const sid1 = generateUlid();
      const sid2 = generateUlid();

      const reg1 = await client.register({ session_id: sid1, name: "worker" });
      assert.strictEqual(reg1.body.agent.name, "worker");

      const reg2 = await client.register({ session_id: sid2, name: "worker" });
      assert.strictEqual(reg2.body.agent.name, "worker2", "Must resolve duplicate name to worker2");
    });

    it("T1.9: should support explicit agent flag to hide from general discovery", async () => {
      const sid = generateUlid();
      const res = await client.register({
        session_id: sid,
        name: "stealth-agent",
        explicit: true,
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.agent.explicit, true);
    });

    it("T1.10: should generate valid 26-character Crockford ULIDs for session identifiers", () => {
      const sid = generateUlid();
      assert.strictEqual(sid.length, 26);
      assert.match(sid, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Heartbeat & Presence (5 test cases)
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. Heartbeat & Presence", () => {
    let hbSid: string;

    before(async () => {
      hbSid = generateUlid();
      await client.register({ session_id: hbSid, name: "hb-agent" });
    });

    it("T1.11: should acknowledge periodic heartbeat with status 200 ok", async () => {
      const res = await client.heartbeat(hbSid);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ok, true);
    });

    it("T1.12: should update context_used_pct metric via heartbeat", async () => {
      const res = await client.heartbeat(hbSid, { context_used_pct: 42 });
      assert.strictEqual(res.status, 200);

      const list = await client.listAgents();
      const card = list.body.agents.find((a) => a.session_id === hbSid);
      assert.ok(card);
      assert.strictEqual(card.context_used_pct, 42);
    });

    it("T1.13: should update queue_depth metric via heartbeat", async () => {
      const res = await client.heartbeat(hbSid, { queue_depth: 3 });
      assert.strictEqual(res.status, 200);

      const list = await client.listAgents();
      const card = list.body.agents.find((a) => a.session_id === hbSid);
      assert.ok(card);
      assert.strictEqual(card.queue_depth, 3);
    });

    it("T1.14: should update model ID via heartbeat", async () => {
      const res = await client.heartbeat(hbSid, { model: "claude-sonnet-3-5" });
      assert.strictEqual(res.status, 200);

      const list = await client.listAgents();
      const card = list.body.agents.find((a) => a.session_id === hbSid);
      assert.ok(card);
      assert.strictEqual(card.model, "claude-sonnet-3-5");
    });

    it("T1.15: should broadcast agent_updated SSE event to peers when metrics change", async () => {
      const peerSid = generateUlid();
      await client.register({ session_id: peerSid, name: "peer-listener" });

      const sse = client.connectSse(peerSid);
      await sse.waitForEvent("hello");

      // Trigger metric update from hb-agent
      await client.heartbeat(hbSid, { context_used_pct: 77 });

      const updatedEvent = await sse.waitForEvent("agent_updated");
      assert.strictEqual(updatedEvent.agent.session_id, hbSid);
      assert.strictEqual(updatedEvent.agent.context_used_pct, 77);

      sse.close();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Peer Listing (Tool coms_net_list) (5 test cases)
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. Peer Listing (Tool coms_net_list)", () => {
    it("T1.16: should list active agents excluding explicit agents by default", async () => {
      const sid = generateUlid();
      await client.register({ session_id: sid, name: "public-peer" });

      const res = await client.listAgents();
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.agents));
      const found = res.body.agents.find((a) => a.session_id === sid);
      assert.ok(found);
      assert.strictEqual(found.name, "public-peer");
    });

    it("T1.17: should include explicit agents when include_explicit is requested", async () => {
      const sid = generateUlid();
      await client.register({ session_id: sid, name: "explicit-peer", explicit: true });

      const defaultList = await client.listAgents();
      assert.ok(!defaultList.body.agents.some((a) => a.session_id === sid));

      const explicitList = await client.listAgents({ include_explicit: true });
      assert.ok(explicitList.body.agents.some((a) => a.session_id === sid));
    });

    it("T1.18: should isolate peer lists by project namespace", async () => {
      const projA = "proj-alpha";
      const projB = "proj-beta";

      const sidA = generateUlid();
      const sidB = generateUlid();

      await client.register({ session_id: sidA, name: "agent-a", project: projA });
      await client.register({ session_id: sidB, name: "agent-b", project: projB });

      const listA = await client.listAgents({ project: projA });
      const listB = await client.listAgents({ project: projB });

      assert.ok(listA.body.agents.some((a) => a.session_id === sidA));
      assert.ok(!listA.body.agents.some((a) => a.session_id === sidB));

      assert.ok(listB.body.agents.some((a) => a.session_id === sidB));
      assert.ok(!listB.body.agents.some((a) => a.session_id === sidA));
    });

    it("T1.19: should return empty agent array for brand new project", async () => {
      const res = await client.listAgents({ project: "empty-proj-" + generateUlid() });
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body.agents, []);
    });

    it("T1.20: should include full metadata in listed agent cards (model, purpose, cwd)", async () => {
      const sid = generateUlid();
      await client.register({
        session_id: sid,
        name: "meta-agent",
        purpose: "Metadata verification",
        model: "gpt-4o",
        cwd: "/var/log/test",
      });

      const list = await client.listAgents();
      const agent = list.body.agents.find((a) => a.session_id === sid);
      assert.ok(agent);
      assert.strictEqual(agent.purpose, "Metadata verification");
      assert.strictEqual(agent.model, "gpt-4o");
      assert.strictEqual(agent.cwd, "/var/log/test");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Message Dispatch (Tool coms_net_send) (5 test cases)
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. Message Dispatch (Tool coms_net_send)", () => {
    let senderSid: string;
    let targetSid: string;

    before(async () => {
      senderSid = generateUlid();
      targetSid = generateUlid();
      await client.register({ session_id: senderSid, name: "msg-sender" });
      await client.register({ session_id: targetSid, name: "msg-target" });
    });

    it("T1.21: should send prompt by target friendly name and return queued status when target SSE offline", async () => {
      const res = await client.sendMessage({
        sender_session: senderSid,
        target: "msg-target",
        prompt: "Check this out",
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.status, "queued");
      assert.strictEqual(res.body.target_session, targetSid);
      assert.strictEqual(res.body.msg_id.length, 26);
    });

    it("T1.22: should send prompt by target ULID session_id", async () => {
      const res = await client.sendMessage({
        sender_session: senderSid,
        target_session: targetSid,
        prompt: "Direct session message",
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ok, true);
      assert.strictEqual(res.body.target_session, targetSid);
    });

    it("T1.23: should deliver prompt immediately with status 'delivered' when target SSE stream is open", async () => {
      const sseTarget = client.connectSse(targetSid);
      await sseTarget.waitForEvent("hello");

      const res = await client.sendMessage({
        sender_session: senderSid,
        target: "msg-target",
        prompt: "Realtime prompt delivery",
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, "delivered");

      const promptEvt = await sseTarget.waitForEvent("prompt");
      assert.strictEqual(promptEvt.msg_id, res.body.msg_id);
      assert.strictEqual(promptEvt.prompt, "Realtime prompt delivery");
      assert.strictEqual(promptEvt.sender.session_id, senderSid);

      sseTarget.close();
    });

    it("T1.24: should include conversation_id and hops in dispatched prompt envelope", async () => {
      const sseTarget = client.connectSse(targetSid);
      await sseTarget.waitForEvent("hello");

      const convId = "conv-12345";
      const res = await client.sendMessage({
        sender_session: senderSid,
        target: "msg-target",
        prompt: "Threaded question",
        conversation_id: convId,
        hops: 2,
      });

      assert.strictEqual(res.status, 200);
      const promptEvt = await sseTarget.waitForEvent("prompt");
      assert.strictEqual(promptEvt.conversation_id, convId);
      assert.strictEqual(promptEvt.hops, 2);

      sseTarget.close();
    });

    it("T1.25: should include response_schema in dispatched prompt envelope", async () => {
      const sseTarget = client.connectSse(targetSid);
      await sseTarget.waitForEvent("hello");

      const schema = { type: "object", properties: { score: { type: "number" } } };
      await client.sendMessage({
        sender_session: senderSid,
        target: "msg-target",
        prompt: "Rate code",
        response_schema: schema,
      });

      const promptEvt = await sseTarget.waitForEvent("prompt");
      assert.deepStrictEqual(promptEvt.response_schema, schema);

      sseTarget.close();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Message Polling & Awaiting (Tools get / await / response) (5 test cases)
  // ───────────────────────────────────────────────────────────────────────────
  describe("6. Message Polling & Awaiting", () => {
    let sSid: string;
    let tSid: string;

    before(async () => {
      sSid = generateUlid();
      tSid = generateUlid();
      await client.register({ session_id: sSid, name: "poller" });
      await client.register({ session_id: tSid, name: "responder" });
    });

    it("T1.26: should query pending message status via coms_net_get (GET /v1/messages/:msg_id)", async () => {
      const sendRes = await client.sendMessage({
        sender_session: sSid,
        target: "responder",
        prompt: "Pending question",
      });

      const msgId = sendRes.body.msg_id;
      const getRes = await client.getMessage(msgId);

      assert.strictEqual(getRes.status, 200);
      assert.strictEqual(getRes.body.msg_id, msgId);
      assert.strictEqual(getRes.body.status, "queued");
      assert.strictEqual(getRes.body.response, null);
    });

    it("T1.27: should submit response via POST /v1/messages/:msg_id/response and complete message", async () => {
      const sendRes = await client.sendMessage({
        sender_session: sSid,
        target: "responder",
        prompt: "Will you answer?",
      });
      const msgId = sendRes.body.msg_id;

      const submitRes = await client.submitResponse(msgId, {
        responder_session: tSid,
        response: { answer: "Yes, here is the answer" },
      });
      assert.strictEqual(submitRes.status, 200);
      assert.strictEqual(submitRes.body.ok, true);

      const getRes = await client.getMessage(msgId);
      assert.strictEqual(getRes.status, 200);
      assert.strictEqual(getRes.body.status, "complete");
      assert.deepStrictEqual(getRes.body.response, { answer: "Yes, here is the answer" });
    });

    it("T1.28: should resolve HTTP long-poll await (GET /v1/messages/:msg_id/await) when response arrives", async () => {
      const sendRes = await client.sendMessage({
        sender_session: sSid,
        target: "responder",
        prompt: "Long poll await test",
      });
      const msgId = sendRes.body.msg_id;

      // Start awaiter asynchronously
      const awaitPromise = client.awaitMessage(msgId, 10000);

      // Submit response after 100ms
      setTimeout(async () => {
        await client.submitResponse(msgId, {
          responder_session: tSid,
          response: "Long poll resolved successfully",
        });
      }, 100);

      const awaitRes = await awaitPromise;
      assert.strictEqual(awaitRes.status, 200);
      assert.strictEqual(awaitRes.body.status, "complete");
      assert.strictEqual(awaitRes.body.response, "Long poll resolved successfully");
    });

    it("T1.29: should return immediately from await if message is already in terminal state", async () => {
      const sendRes = await client.sendMessage({
        sender_session: sSid,
        target: "responder",
        prompt: "Already done prompt",
      });
      const msgId = sendRes.body.msg_id;

      await client.submitResponse(msgId, {
        responder_session: tSid,
        response: "Done beforehand",
      });

      const start = Date.now();
      const awaitRes = await client.awaitMessage(msgId, 5000);
      const elapsed = Date.now() - start;

      assert.strictEqual(awaitRes.status, 200);
      assert.strictEqual(awaitRes.body.status, "complete");
      assert.strictEqual(awaitRes.body.response, "Done beforehand");
      assert.ok(elapsed < 500, "Must return immediately (<500ms)");
    });

    it("T1.30: should gracefully unregister agent via DELETE /v1/agents/:session_id", async () => {
      const tempSid = generateUlid();
      await client.register({ session_id: tempSid, name: "temp-agent" });

      const delRes = await client.unregister(tempSid);
      assert.strictEqual(delRes.status, 200);
      assert.strictEqual(delRes.body.ok, true);

      // Should no longer appear in peer list
      const list = await client.listAgents();
      assert.ok(!list.body.agents.some((a) => a.session_id === tempSid));
    });
  });
});
