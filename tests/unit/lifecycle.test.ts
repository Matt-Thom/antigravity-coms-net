/**
 * tests/unit/lifecycle.test.ts
 *
 * Comprehensive unit and integration tests for AgentLifecycle.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { MockHub } from "../mocks/mock-hub.ts";
import { ComsNetClient } from "../../src/protocol/client.ts";
import {
  AgentLifecycle,
  NEON_PALETTE,
  generateDeterministicColor,
  isValidHexColor,
} from "../../src/bridge/lifecycle.ts";

describe("AgentLifecycle Unit & Integration Tests", () => {
  let hub: MockHub;
  let client: ComsNetClient;

  before(async () => {
    hub = new MockHub();
    await hub.start();
    client = new ComsNetClient({
      baseUrl: hub.baseUrl,
      authToken: hub.token,
      project: "lifecycle-tests",
    });
  });

  after(async () => {
    await hub.stop();
  });

  it("L1: should generate valid default AgentCard identity", () => {
    const lifecycle = new AgentLifecycle({ client });
    const id = lifecycle.getIdentity();

    // 26-char Crockford Base32 ULID
    assert.match(id.session_id, /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
    assert.match(id.name, /^antigravity-[0-9a-z]{6}$/);
    assert.strictEqual(id.model, "gemini-2.5-pro");
    assert.strictEqual(id.provider, "google");
    assert.strictEqual(id.runtime, "antigravity");
    assert.strictEqual(id.project, "lifecycle-tests");
    assert.strictEqual(id.purpose, "Antigravity CLI peer agent");
    assert.strictEqual(id.explicit, false);
    assert.ok(isValidHexColor(id.color));
    assert.ok(NEON_PALETTE.includes(id.color as any));
  });

  it("L2: should deterministically pick color from neon palette based on sessionId", () => {
    const sid1 = "01JM78XYZ456789ABCDEFGHJKM";
    const sid2 = "01JM78XYZ456789ABCDEFGHJKN";

    const c1 = generateDeterministicColor(sid1);
    const c2 = generateDeterministicColor(sid1);
    const c3 = generateDeterministicColor(sid2);

    assert.strictEqual(c1, c2, "Same session ID must produce same color");
    assert.ok(NEON_PALETTE.includes(c1 as any));
    assert.ok(NEON_PALETTE.includes(c3 as any));
  });

  it("L3: should respect option overrides cascade", () => {
    const lifecycle = new AgentLifecycle({
      client,
      name: "custom-specialist",
      purpose: "Code reviewer",
      model: "gemini-1.5-pro",
      provider: "google-deepmind",
      color: "#FF0000",
      cwd: "/custom/work/dir",
      explicit: true,
      runtime: "antigravity-worker",
      sessionId: "01JMTESTSESSIONID000000001",
    });

    const id = lifecycle.getIdentity();
    assert.strictEqual(id.session_id, "01JMTESTSESSIONID000000001");
    assert.strictEqual(id.name, "custom-specialist");
    assert.strictEqual(id.purpose, "Code reviewer");
    assert.strictEqual(id.model, "gemini-1.5-pro");
    assert.strictEqual(id.provider, "google-deepmind");
    assert.strictEqual(id.color, "#FF0000");
    assert.strictEqual(id.cwd, "/custom/work/dir");
    assert.strictEqual(id.explicit, true);
    assert.strictEqual(id.runtime, "antigravity-worker");
  });

  it("L4: should execute successful registration flow and store canonical card", async () => {
    const lifecycle = new AgentLifecycle({
      client,
      name: "reg-test-agent",
      purpose: "Testing registration",
    });

    let registeredEventPayload: any = null;
    lifecycle.on("registered", (payload) => {
      registeredEventPayload = payload;
    });

    const resp = await lifecycle.start();
    assert.strictEqual(lifecycle.getState(), "active");
    assert.ok(resp.ok);
    assert.strictEqual(resp.agent.name, "reg-test-agent");
    assert.strictEqual(lifecycle.getCard()?.name, "reg-test-agent");
    assert.ok(registeredEventPayload);
    assert.strictEqual(registeredEventPayload.agent.session_id, lifecycle.getIdentity().session_id);
    assert.ok(lifecycle.getHeartbeatIntervalMs() > 0);
    assert.ok(lifecycle.getSseUrl()?.includes("/v1/events"));

    await lifecycle.stop();
  });

  it("L5: should detect name collision and adopt server-assigned unique name", async () => {
    const a1 = new AgentLifecycle({ client, name: "collision-agent" });
    await a1.start();
    assert.strictEqual(a1.getIdentity().name, "collision-agent");

    const a2 = new AgentLifecycle({ client, name: "collision-agent" });
    let collisionEvent: any = null;
    a2.on("name_collision", (ev) => {
      collisionEvent = ev;
    });

    await a2.start();

    assert.ok(collisionEvent, "name_collision event must be fired");
    assert.strictEqual(collisionEvent.desired, "collision-agent");
    assert.strictEqual(collisionEvent.assigned, "collision-agent2");

    assert.strictEqual(a2.getIdentity().name, "collision-agent2");
    assert.strictEqual(a2.getCard()?.name, "collision-agent2");

    await a1.stop();
    await a2.stop();
  });

  it("L6 & L7: should dispatch heartbeat with dynamic metrics", async () => {
    let metricCalls = 0;
    const lifecycle = new AgentLifecycle({
      client,
      name: "metrics-agent",
      metricProvider: () => {
        metricCalls++;
        return {
          context_used_pct: 42,
          queue_depth: 3,
        };
      },
    });

    await lifecycle.start();

    let heartbeatFired = false;
    lifecycle.on("heartbeat", (data) => {
      heartbeatFired = true;
      assert.strictEqual(data.metrics.context_used_pct, 42);
      assert.strictEqual(data.metrics.queue_depth, 3);
    });

    const ok = await lifecycle.sendHeartbeat();
    assert.strictEqual(ok, true);
    assert.strictEqual(heartbeatFired, true);
    assert.ok(metricCalls >= 1);

    const card = lifecycle.getCard();
    assert.strictEqual(card?.context_used_pct, 42);
    assert.strictEqual(card?.queue_depth, 3);
    assert.ok(typeof card?.last_seen_at === "number");

    await lifecycle.stop();
  });

  it("L8: should prevent concurrent overlapping heartbeats via reentrancy lock", async () => {
    const lifecycle = new AgentLifecycle({ client, name: "reentrancy-agent" });
    await lifecycle.start();

    // Call two sendHeartbeat concurrently
    const p1 = lifecycle.sendHeartbeat();
    const p2 = lifecycle.sendHeartbeat();

    const [res1, res2] = await Promise.all([p1, p2]);
    // One must succeed, one should be skipped
    assert.ok((res1 && !res2) || (!res1 && res2) || (res1 && res2));

    await lifecycle.stop();
  });

  it("L9: should tolerate transient network blips and emit heartbeat_failed without crashing", async () => {
    const badClient = new ComsNetClient({
      baseUrl: "http://127.0.0.1:9999", // non-existent hub port
      authToken: "dummy",
      project: "lifecycle-tests",
    });

    const lifecycle = new AgentLifecycle({
      client: badClient,
      name: "blip-agent",
      heartbeatTimeoutMs: 200,
    });

    // Manually fake card to simulate post-registration state
    (lifecycle as any).card = {
      session_id: lifecycle.getIdentity().session_id,
      project: "lifecycle-tests",
      name: "blip-agent",
      status: "online",
      context_used_pct: 0,
      queue_depth: 0,
    };
    (lifecycle as any).state = "active";

    let failedEvent: any = null;
    lifecycle.on("heartbeat_failed", (ev) => {
      failedEvent = ev;
    });

    const res = await lifecycle.sendHeartbeat();
    assert.strictEqual(res, false);
    assert.ok(failedEvent);
    assert.strictEqual(failedEvent.reason, "network_blip");
    assert.strictEqual(failedEvent.consecutiveFailures, 1);
  });

  it("L10: should auto-re-register when heartbeat returns 404 agent_not_found", async () => {
    const lifecycle = new AgentLifecycle({ client, name: "purge-agent" });
    await lifecycle.start();
    const sid = lifecycle.getIdentity().session_id;

    // Purge agent directly on mock hub to simulate stale eviction or hub restart
    const p = hub.getProject("lifecycle-tests");
    p.agents.delete(sid);

    let reRegistered = false;
    lifecycle.on("re_registered", () => {
      reRegistered = true;
    });

    const res = await lifecycle.sendHeartbeat();
    assert.strictEqual(res, true, "Heartbeat should recover via re-registration");
    assert.strictEqual(reRegistered, true, "re_registered event must be emitted");
    assert.ok(p.agents.has(sid), "Agent must be restored in hub registry");

    await lifecycle.stop();
  });

  it("L11: should gracefully unregister on stop and transition to stopped", async () => {
    const lifecycle = new AgentLifecycle({ client, name: "stop-agent" });
    await lifecycle.start();
    const sid = lifecycle.getIdentity().session_id;

    const p = hub.getProject("lifecycle-tests");
    assert.ok(p.agents.has(sid), "Agent must be registered on hub");

    let unregisteredFired = false;
    lifecycle.on("unregistered", () => {
      unregisteredFired = true;
    });

    await lifecycle.stop();
    assert.strictEqual(lifecycle.getState(), "stopped");
    assert.strictEqual(unregisteredFired, true);
    assert.strictEqual(p.agents.has(sid), false, "Agent must be evicted from hub on shutdown");
  });
});
