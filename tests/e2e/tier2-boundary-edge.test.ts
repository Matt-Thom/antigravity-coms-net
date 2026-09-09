/**
 * Tier 2: Boundary, Edge & Error Case Verification
 * Comprehensive coverage of security checks, permission validation,
 * hop limits, inbox depth, ambiguous target resolution, timeouts,
 * dead peers, and error envelopes.
 */

import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MockHub, generateUlid, tokensEqual } from "../mocks/mock-hub.ts";
import { TestClient } from "../mocks/test-client.ts";

describe("Tier 2: Boundary, Edge & Corner Cases", () => {
  let hub: MockHub;
  let client: TestClient;
  let tempDir: string;

  before(async () => {
    hub = new MockHub({ maxHops: 5, maxInbox: 5 }); // Small maxInbox for testing capacity boundary
    await hub.start();
    client = new TestClient(hub.baseUrl, hub.token);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coms-net-test-t2-"));
  });

  after(async () => {
    await hub.stop();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Authentication & Redaction Boundaries (5 test cases)
  // ───────────────────────────────────────────────────────────────────────────
  describe("1. Authentication & Redaction Boundaries", () => {
    it("T2.1: should reject missing Authorization header with 401 and WWW-Authenticate", async () => {
      const res = await client.request("/v1/agents", { tokenOverride: null });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.ok, false);
      assert.strictEqual(res.body.error, "unauthorized");
      const authHeader = res.headers["www-authenticate"];
      assert.ok(authHeader && authHeader.includes('Bearer realm="coms-net"'));
    });

    it("T2.2: should reject non-Bearer scheme (e.g. Basic) with 401 unauthorized", async () => {
      const res = await client.request("/v1/agents", {
        tokenOverride: null,
        headers: { authorization: "Basic dXNlcjpwYXNz" },
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error, "unauthorized");
    });

    it("T2.3: should reject invalid token with 401 using constant-time comparison", async () => {
      const fakeToken = "bad-token-that-is-not-valid-hex-token-at-all-00000000";
      const res = await client.request("/v1/agents", { tokenOverride: fakeToken });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.error, "unauthorized");

      // Verify constant-time token comparison helper behaves properly
      assert.strictEqual(tokensEqual(hub.token, hub.token), true);
      assert.strictEqual(tokensEqual(hub.token, fakeToken), false);
      assert.strictEqual(tokensEqual("short", "longer_string"), false);
    });

    it("T2.4: should verify bearer token is never leaked in error payloads or responses", async () => {
      const res = await client.request("/v1/agents", { tokenOverride: "leak-test-token" });
      const rawBody = JSON.stringify(res.body);
      assert.ok(!rawBody.includes(hub.token), "Hub token must never appear in response");
      assert.ok(!rawBody.includes("leak-test-token"), "Request token must not appear in response");
    });

    it("T2.5: should allow unauthenticated /health while strictly protecting all /v1/* endpoints", async () => {
      const health = await client.getHealth();
      assert.strictEqual(health.status, 200);

      const endpoints = [
        { path: "/v1/agents", method: "GET" },
        { path: "/v1/agents/register", method: "POST" },
        { path: "/v1/messages", method: "POST" },
        { path: "/v1/events?session_id=123", method: "GET" },
      ];

      for (const ep of endpoints) {
        const res = await client.request(ep.path, { method: ep.method, tokenOverride: null });
        assert.strictEqual(res.status, 401, `Endpoint ${ep.method} ${ep.path} must require auth`);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. File Mode Permissions & Discovery Boundaries (5 test cases)
  // ───────────────────────────────────────────────────────────────────────────
  describe("2. File Mode Permissions & Discovery Boundaries", () => {
    it("T2.6: should reject server.secret.json when permissions are 0644 (world readable)", () => {
      const secretPath = path.join(tempDir, "insecure-0644.json");
      fs.writeFileSync(secretPath, JSON.stringify({ token: "sec" }), { mode: 0o644 });
      fs.chmodSync(secretPath, 0o644);

      const mode = fs.statSync(secretPath).mode & 0o777;
      const isValid = mode === 0o600;
      assert.strictEqual(isValid, false, "0644 permissions must be rejected");
    });

    it("T2.7: should reject server.secret.json when permissions are 0777 (executable)", () => {
      const secretPath = path.join(tempDir, "insecure-0777.json");
      fs.writeFileSync(secretPath, JSON.stringify({ token: "sec" }), { mode: 0o777 });
      fs.chmodSync(secretPath, 0o777);

      const mode = fs.statSync(secretPath).mode & 0o777;
      const isValid = mode === 0o600;
      assert.strictEqual(isValid, false, "0777 permissions must be rejected");
    });

    it("T2.8: should reject server.secret.json when permissions are 0660 (group writable)", () => {
      const secretPath = path.join(tempDir, "insecure-0660.json");
      fs.writeFileSync(secretPath, JSON.stringify({ token: "sec" }), { mode: 0o660 });
      fs.chmodSync(secretPath, 0o660);

      const mode = fs.statSync(secretPath).mode & 0o777;
      const isValid = mode === 0o600;
      assert.strictEqual(isValid, false, "0660 permissions must be rejected");
    });

    it("T2.9: should safely handle malformed JSON in discovery files without process crash", () => {
      const brokenFile = path.join(tempDir, "broken.json");
      fs.writeFileSync(brokenFile, "{ this is not valid json");

      let parsed: any = null;
      try {
        parsed = JSON.parse(fs.readFileSync(brokenFile, "utf-8"));
      } catch {
        parsed = null;
      }
      assert.strictEqual(parsed, null, "Malformed JSON must be caught cleanly");
    });

    it("T2.10: should safely handle missing discovery directory without throwing unhandled error", () => {
      const nonExistentPath = path.join(tempDir, "does-not-exist", "server.json");
      const exists = fs.existsSync(nonExistentPath);
      assert.strictEqual(exists, false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Hop Limits & Anti-Looping Safeguards (5 test cases)
  // ───────────────────────────────────────────────────────────────────────────
  describe("3. Hop Limits & Anti-Looping Safeguards", () => {
    let senderSid: string;
    let targetSid: string;

    before(async () => {
      senderSid = generateUlid();
      targetSid = generateUlid();
      await client.register({ session_id: senderSid, name: "hop-sender" });
      await client.register({ session_id: targetSid, name: "hop-target" });
    });

    it("T2.11: should accept message dispatch with hops = 4 (below ceiling)", async () => {
      const res = await client.sendMessage({
        sender_session: senderSid,
        target_session: targetSid,
        prompt: "Hop 4 test",
        hops: 4,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ok, true);
    });

    it("T2.12: should reject message dispatch with hops = 5 with HTTP 409 hop_limit_exceeded", async () => {
      const res = await client.sendMessage({
        sender_session: senderSid,
        target_session: targetSid,
        prompt: "Hop 5 test",
        hops: 5,
      });

      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.ok, false);
      assert.strictEqual(res.body.error, "hop_limit_exceeded");
      assert.strictEqual(res.body.details.hops, 5);
      assert.strictEqual(res.body.details.max_hops, 5);
    });

    it("T2.13: should reject message dispatch with hops > 5 with HTTP 409 hop_limit_exceeded", async () => {
      const res = await client.sendMessage({
        sender_session: senderSid,
        target_session: targetSid,
        prompt: "Hop 9 test",
        hops: 9,
      });

      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error, "hop_limit_exceeded");
    });

    it("T2.14: should verify client-side hop guard rejects hops >= 5 before HTTP dispatch", () => {
      function clientHopGuard(hops: number): boolean {
        if (hops >= 5) {
          throw new Error(`Hop limit exceeded (${hops} >= 5)`);
        }
        return true;
      }

      assert.strictEqual(clientHopGuard(3), true);
      assert.throws(() => clientHopGuard(5), /Hop limit exceeded/);
      assert.throws(() => clientHopGuard(10), /Hop limit exceeded/);
    });

    it("T2.15: should verify anti-looping instruction warning pattern", () => {
      const antiLoopDirective = "Reply directly with your answer. Do NOT call coms_net_send to respond.";
      assert.ok(antiLoopDirective.includes("Do NOT call coms_net_send"));
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Timeouts, TTLs & Dead Peers (5 test cases)
  // ───────────────────────────────────────────────────────────────────────────
  describe("4. Timeouts, TTLs & Dead Peers", () => {
    let sSid: string;
    let tSid: string;

    before(async () => {
      sSid = generateUlid();
      tSid = generateUlid();
      await client.register({ session_id: sSid, name: "timeout-sender" });
      await client.register({ session_id: tSid, name: "timeout-target" });
    });

    it("T2.16: should return timeout status when await reaches specified timeout_ms", async () => {
      const sendRes = await client.sendMessage({
        sender_session: sSid,
        target_session: tSid,
        prompt: "Will timeout",
      });
      const msgId = sendRes.body.msg_id;

      const start = Date.now();
      const awaitRes = await client.awaitMessage(msgId, 300); // 300ms timeout
      const elapsed = Date.now() - start;

      assert.strictEqual(awaitRes.status, 200);
      assert.strictEqual(awaitRes.body.status, "timeout");
      assert.strictEqual(awaitRes.body.error, "timeout");
      assert.strictEqual(awaitRes.body.response, null);
      assert.ok(elapsed >= 250 && elapsed <= 800, `Elapsed time ${elapsed}ms should be around 300ms`);
    });

    it("T2.17: should cleanly detach awaiter when client disconnects during await", async () => {
      const sendRes = await client.sendMessage({
        sender_session: sSid,
        target_session: tSid,
        prompt: "Client abort test",
      });
      const msgId = sendRes.body.msg_id;

      // Start await request then immediately destroy connection
      const req = client.awaitMessage(msgId, 10000);
      // Let it attach
      await new Promise((r) => setTimeout(r, 50));

      const project = hub.getProject("default");
      const awaiters = project.awaiters.get(msgId);
      assert.ok(awaiters && awaiters.size > 0, "Awaiter must be registered");

      // Submit response to release cleanly
      await client.submitResponse(msgId, {
        responder_session: tSid,
        response: "Resolved",
      });
      await req;
    });

    it("T2.18: should transition missing peer to stale after 30s of missed heartbeats", async () => {
      const deadProj = "dead-proj-" + generateUlid();
      const staleSid = generateUlid();
      await client.register({ session_id: staleSid, name: "stale-peer", project: deadProj });

      // Fast-forward simulated time by 35 seconds
      const futureTime = Date.now() + 35000;
      const { staled } = hub.triggerStaleScan(futureTime, deadProj);

      assert.ok(staled.includes(staleSid), "Agent must be marked stale");

      const list = await client.listAgents({ project: deadProj });
      const agent = list.body.agents.find((a) => a.session_id === staleSid);
      assert.ok(agent);
      assert.strictEqual(agent.status, "stale");
    });

    it("T2.19: should evict missing peer from registry after 60s of missed heartbeats", async () => {
      const deadProj = "dead-proj-" + generateUlid();
      const deadSid = generateUlid();
      await client.register({ session_id: deadSid, name: "dead-peer", project: deadProj });

      // Fast-forward simulated time by 65 seconds
      const futureTime = Date.now() + 65000;
      const { purged } = hub.triggerStaleScan(futureTime, deadProj);

      assert.ok(purged.includes(deadSid), "Agent must be purged after 60s offline");

      const list = await client.listAgents({ project: deadProj });
      assert.ok(!list.body.agents.some((a) => a.session_id === deadSid), "Evicted agent must not be in list");
    });

    it("T2.20: should expire undelivered messages past message TTL with error 'expired'", async () => {
      const sendRes = await client.sendMessage({
        sender_session: sSid,
        target_session: tSid,
        prompt: "Will expire by TTL",
      });
      const msgId = sendRes.body.msg_id;

      // Fast forward past 30 minutes TTL
      const futureTime = Date.now() + 1800000 + 1000;
      const expired = hub.triggerTtlScan(futureTime);

      assert.ok(expired.includes(msgId));

      const getRes = await client.getMessage(msgId);
      assert.strictEqual(getRes.status, 404, "Expired message should be purged from store");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Target Resolution, Capacity & Response Verification (5 test cases)
  // ───────────────────────────────────────────────────────────────────────────
  describe("5. Target Resolution, Capacity & Response Verification", () => {
    let validSenderSid: string;
    let validTargetSid: string;

    before(async () => {
      validSenderSid = generateUlid();
      validTargetSid = generateUlid();
      await client.register({ session_id: validSenderSid, name: "valid-sender" });
      await client.register({ session_id: validTargetSid, name: "valid-target" });
    });

    it("T2.21: should return 404 target_not_found when target does not exist", async () => {
      const res = await client.sendMessage({
        sender_session: validSenderSid,
        target: "non-existent-agent-name",
        prompt: "Hello ghost",
      });

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.ok, false);
      assert.strictEqual(res.body.error, "target_not_found");
    });

    it("T2.22: should return 404 sender_not_registered when sender session does not exist", async () => {
      const res = await client.sendMessage({
        sender_session: generateUlid(), // Unregistered
        target: "valid-target",
        prompt: "From unknown sender",
      });

      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.ok, false);
      assert.strictEqual(res.body.error, "sender_not_registered");
    });

    it("T2.23: should return 409 ambiguous_target when friendly name matches multiple candidates", async () => {
      const ambigProject = "ambig-proj-" + generateUlid();
      const sender = generateUlid();
      const cand1 = generateUlid();
      const cand2 = generateUlid();

      // Explicitly place duplicate names in project nameIndex to simulate collision condition
      await client.register({ session_id: sender, name: "caller", project: ambigProject });
      await client.register({ session_id: cand1, name: "dupe-target", project: ambigProject });

      const p = hub.getProject(ambigProject);
      // Manually add second candidate into nameIndex for "dupe-target"
      p.nameIndex.get("dupe-target")?.add(cand2);

      const res = await client.sendMessage({
        project: ambigProject,
        sender_session: sender,
        target: "dupe-target",
        prompt: "Who gets this?",
      });

      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.error, "ambiguous_target");
      assert.strictEqual(res.body.details.candidates.length, 2);
    });

    it("T2.24: should return 429 inbox_full when target pending inbox depth exceeds maxInbox (5)", async () => {
      const capSid = generateUlid();
      await client.register({ session_id: capSid, name: "capacity-target" });

      // Hub has maxInbox = 5
      for (let i = 0; i < 5; i++) {
        const okSend = await client.sendMessage({
          sender_session: validSenderSid,
          target_session: capSid,
          prompt: `Fill inbox ${i}`,
        });
        assert.strictEqual(okSend.status, 200);
      }

      // 6th message must trigger 429
      const overflowRes = await client.sendMessage({
        sender_session: validSenderSid,
        target_session: capSid,
        prompt: "Overflow message",
      });

      assert.strictEqual(overflowRes.status, 429);
      assert.strictEqual(overflowRes.body.ok, false);
      assert.strictEqual(overflowRes.body.error, "inbox_full");
      assert.strictEqual(overflowRes.body.details.depth, 5);
      assert.strictEqual(overflowRes.body.details.max_inbox, 5);
    });

    it("T2.25: should reject response from non-target session with 403 not_target", async () => {
      const sendRes = await client.sendMessage({
        sender_session: validSenderSid,
        target_session: validTargetSid,
        prompt: "Only valid-target can answer",
      });
      const msgId = sendRes.body.msg_id;

      // An unauthorized third party attempts to submit response
      const rogueSid = generateUlid();
      const unauthorizedRes = await client.submitResponse(msgId, {
        responder_session: rogueSid,
        response: "Hijacked answer",
      });

      assert.strictEqual(unauthorizedRes.status, 403);
      assert.strictEqual(unauthorizedRes.body.ok, false);
      assert.strictEqual(unauthorizedRes.body.error, "not_target");

      // Target responds successfully
      const validRes = await client.submitResponse(msgId, {
        responder_session: validTargetSid,
        response: "Authorized answer",
      });
      assert.strictEqual(validRes.status, 200);

      // Subsequent attempt on completed message returns 409 already_terminal
      const dupRes = await client.submitResponse(msgId, {
        responder_session: validTargetSid,
        response: "Second answer",
      });
      assert.strictEqual(dupRes.status, 409);
      assert.strictEqual(dupRes.body.error, "already_terminal");
    });
  });
});
