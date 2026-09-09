/**
 * tests/unit/adversarial.test.ts
 *
 * Empirical Challenger Test Suite for Milestone M1
 * Probing:
 * 1. Discovery security & file permissions (exact 0600, symlinks, directory traversal ../../)
 * 2. Token redaction under extreme string inputs and nested error objects
 * 3. Hop limit enforcement (0, 1, 4, 5, 6, -1, NaN, floats, Infinity)
 * 4. 3-way race resolution in coms_net_await (race conditions, rapid cancellation, socket leak detection, pendingReplies lifecycle)
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import * as util from "node:util";

import {
  discoverHubSync,
  readServerSecret,
  readServerJson,
  validateProjectName,
  safeHubConfig,
  ENV_SERVER_URL,
  ENV_AUTH_TOKEN,
  ENV_PROJECT,
} from "../../src/protocol/discovery.ts";
import {
  ComsNetError,
  HubDiscoveryError,
  NoServerUrlError,
  NoAuthTokenError,
  InvalidProjectNameError,
  HopLimitExceededError,
  ConnectionRefusedError,
  ComsNetHttpError,
  UnauthorizedError,
  redactToken,
} from "../../src/protocol/errors.ts";
import { ComsNetClient } from "../../src/protocol/client.ts";
import {
  ComsNetTools,
  generateUlid,
  type ToolContext,
  type PendingReply,
  type IComsClient,
  type InboundContext,
} from "../../src/protocol/tools.ts";

describe("Adversarial Probing: 1. Discovery Security & File Permissions", () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coms-adv-disc-"));
    projectDir = path.join(tempDir, "projects", "default");
    fs.mkdirSync(projectDir, { recursive: true });
    delete process.env[ENV_SERVER_URL];
    delete process.env[ENV_AUTH_TOKEN];
    delete process.env[ENV_PROJECT];
  });

  afterEach(() => {
    delete process.env[ENV_SERVER_URL];
    delete process.env[ENV_AUTH_TOKEN];
    delete process.env[ENV_PROJECT];
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("perm-matrix: strictly requires 0600 and rejects all other permission modes", () => {
    const secretPath = path.join(projectDir, "server.secret.json");
    fs.writeFileSync(secretPath, JSON.stringify({ token: "valid-secret" }));

    // Modes to test
    const modesToReject = [
      0o644, // rw-r--r--
      0o777, // rwxrwxrwx
      0o700, // rwx------ (executable by owner is NOT allowed)
      0o400, // r-------- (read only by owner is NOT 0600)
      0o660, // rw-rw----
      0o604, // rw----r--
      0o666, // rw-rw-rw-
      0o000, // ---------
    ];

    for (const mode of modesToReject) {
      fs.chmodSync(secretPath, mode);
      const res = readServerSecret(projectDir);
      assert.equal(res.secret, null, `Mode 0o${mode.toString(8)} must be rejected`);
      assert.ok(
        res.rejectionReason?.includes("insecure_permissions") || res.rejectionReason?.includes("read_error"),
        `Rejection reason should indicate failure for 0o${mode.toString(8)}`
      );
    }

    // Mode 0600 must succeed
    fs.chmodSync(secretPath, 0o600);
    const validRes = readServerSecret(projectDir);
    assert.deepEqual(validRes.secret, { token: "valid-secret" });
  });

  it("symlink-probing: rejects symlink pointing to a legitimate 0600 file", () => {
    const realSecretPath = path.join(tempDir, "real_secret.json");
    fs.writeFileSync(realSecretPath, JSON.stringify({ token: "symlink-target-token" }));
    fs.chmodSync(realSecretPath, 0o600);

    const symlinkPath = path.join(projectDir, "server.secret.json");
    fs.symlinkSync(realSecretPath, symlinkPath);

    const res = readServerSecret(projectDir);
    assert.equal(res.secret, null, "Symlinked server.secret.json must be rejected");
    assert.equal(res.rejectionReason, "symlink_not_allowed");
  });

  it("symlink-probing: handles broken symlinks without crashing", () => {
    const symlinkPath = path.join(projectDir, "server.secret.json");
    fs.symlinkSync("/nonexistent/target/file.json", symlinkPath);

    const res = readServerSecret(projectDir);
    assert.equal(res.secret, null, "Broken symlink must be rejected");
    assert.ok(res.rejectionReason === "file_not_found" || res.rejectionReason === "symlink_not_allowed");
  });

  it("path-traversal: strictly rejects all traversal and injection sequences in project name", () => {
    const adversarialProjects = [
      "../../",
      "../",
      "..",
      ".",
      "/",
      "/etc/passwd",
      "projects/../default",
      "default/../../etc",
      "default\0nullbyte",
      "default%2f..%2f",
      "default;rm -rf",
      "default & echo pwned",
      "default space",
      "default\nnewline",
      "default\rreturn",
      "*",
      "default*",
      "default?",
    ];

    for (const proj of adversarialProjects) {
      assert.throws(
        () => validateProjectName(proj),
        InvalidProjectNameError,
        `Project name "${proj}" should throw InvalidProjectNameError`
      );

      assert.throws(
        () => discoverHubSync({ project: proj, registryDir: tempDir }),
        InvalidProjectNameError,
        `discoverHubSync with project "${proj}" should throw InvalidProjectNameError`
      );
    }
  });

  it("url-validation: rejects non-http(s) protocols and malformed URLs", () => {
    const invalidUrls = [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "ftp://example.com",
      "ws://example.com",
      "not-a-url",
      "http://",
      "://bad",
    ];

    fs.writeFileSync(
      path.join(projectDir, "server.secret.json"),
      JSON.stringify({ token: "test-token" })
    );
    fs.chmodSync(path.join(projectDir, "server.secret.json"), 0o600);

    for (const badUrl of invalidUrls) {
      assert.throws(
        () => discoverHubSync({ serverUrl: badUrl, registryDir: tempDir }),
        (err) => err instanceof HubDiscoveryError || err instanceof TypeError,
        `URL "${badUrl}" must be rejected as invalid server URL`
      );
    }
  });

  it("secret-parsing: rejects empty, non-string, whitespace-only, and malformed secret JSON", () => {
    const secretPath = path.join(projectDir, "server.secret.json");
    const badContents = [
      "",
      "not-json",
      "{}",
      JSON.stringify({ token: "" }),
      JSON.stringify({ token: "   " }),
      JSON.stringify({ token: 12345 }),
      JSON.stringify({ token: null }),
      JSON.stringify({ token: true }),
      JSON.stringify({ token: {} }),
      JSON.stringify({ not_token: "xyz" }),
    ];

    for (const content of badContents) {
      fs.writeFileSync(secretPath, content);
      fs.chmodSync(secretPath, 0o600);
      const res = readServerSecret(projectDir);
      assert.equal(res.secret, null, `Bad content "${content}" must return secret: null`);
      assert.ok(
        res.rejectionReason?.startsWith("read_error") || res.rejectionReason === "invalid_secret_json_format",
        `Expected rejection reason for content "${content}", got: ${res.rejectionReason}`
      );
    }
  });
});

describe("Adversarial Probing: 2. Token Redaction & Nested Error Objects", () => {
  it("redacts raw token occurrences even with regex-special characters", () => {
    const specialToken = "tok.*+?^${}()|[]\\special";
    const text = `Error connecting with auth token: ${specialToken} to server`;
    const redacted = redactToken(text, specialToken);
    assert.equal(redacted, "Error connecting with auth token: <redacted> to server");
    assert.ok(!redacted.includes(specialToken));
  });

  it("redacts multiple occurrences and extreme string length", () => {
    const token = "super-secret-token-123456";
    const longString = ("prefix " + token + " suffix ").repeat(1000);
    const redacted = redactToken(longString, token);
    assert.ok(!redacted.includes(token));
    assert.equal(redacted.split("<redacted>").length - 1, 1000);
  });

  it("handles falsy, empty, and undefined token / text safely", () => {
    assert.equal(redactToken(""), "");
    assert.equal(redactToken("hello", ""), "hello");
    assert.equal(redactToken("hello", undefined), "hello");
  });

  it("redaction regex test: Bearer token variants", () => {
    const cases = [
      { input: "Authorization: Bearer my_token_123", expected: "Authorization: Bearer <redacted>" },
      { input: "bearer ABC.DEF-123_456", expected: "Bearer <redacted>" },
    ];
    for (const c of cases) {
      assert.equal(redactToken(c.input), c.expected);
    }
  });

  it("identifies boundary behavior: Base64 Bearer tokens with trailing padding", () => {
    // Probe finding: regex /Bearer\s+[A-Za-z0-9_\-\.]+/ leaves trailing '=' unredacted
    const b64Token = "Bearer dGVzdA==";
    const redacted = redactToken(b64Token);
    // Empirical observation: "Bearer <redacted>=="
    assert.equal(redacted, "Bearer <redacted>==");
  });

  it("identifies boundary behavior: JSON token fallback regex only matches hex tokens", () => {
    // Hex token matches fallback regex
    const hexJson = '{"token": "0123456789abcdef0123456789abcdef"}';
    assert.equal(redactToken(hexJson), '{"token": "<redacted>"}');

    // Non-hex token does NOT match fallback regex when explicit token is omitted
    const nonHexJson = '{"token": "my-secret-token-xyz-12345"}';
    const redacted = redactToken(nonHexJson);
    // Empirical observation: fallback regex requires [0-9a-fA-F], leaves non-hex unredacted
    assert.equal(redacted, nonHexJson);

    // But when explicit token is passed, it is scrubbed
    const scrubbed = redactToken(nonHexJson, "my-secret-token-xyz-12345");
    assert.equal(scrubbed, '{"token": "<redacted>"}');
  });

  it("ComsNetError scrubs message and stack trace", () => {
    const token = "secret-token-stack-leak";
    const err = new ComsNetError(`Failed with token: ${token}`, token);
    assert.ok(!err.message.includes(token), "Message must not leak token");
    assert.ok(!err.stack?.includes(token), "Stack must not leak token");
    assert.ok(err.message.includes("<redacted>"));
    assert.ok(util.inspect(err).includes("<redacted>"));
    assert.ok(!util.inspect(err).includes(token));
  });

  it("identifies boundary behavior: nested Error causes retain unredacted messages", () => {
    const token = "nested-secret-token-xyz";
    const innerCause = new Error(`Connection failed with token ${token}`);
    const err = new ConnectionRefusedError("http://hub", innerCause, token);

    // Top-level message and stack are sanitized
    assert.ok(!err.message.includes(token));
    // Nested cause is stored as-is without deep recursive redaction
    assert.ok(err.cause?.message.includes(token));
  });
});

describe("Adversarial Probing: 3. Hop Limit Enforcement", () => {
  let mockClient: IComsClient;
  let toolCtx: ToolContext;
  let sentHops: number[] = [];

  beforeEach(() => {
    sentHops = [];
    mockClient = {
      async getAgents() { return { agents: [] }; },
      async sendMessage(params) {
        sentHops.push(params.hops);
        return { ok: true, msg_id: "01J7MSG0000000000000000001", status: "queued", target_session: "target-sid" };
      },
      async getMessage(id) { return { msg_id: id, status: "queued", response: null, error: null }; },
      async awaitMessage(id) { return { msg_id: id, status: "complete", response: "ok", error: null }; },
    };

    toolCtx = {
      client: mockClient,
      identity: { session_id: "01J7SELF000000000000000001", name: "self", project: "default" },
      pendingReplies: new Map(),
    };
  });

  it("hop-boundaries: strictly rejects hops >= 5 with HopLimitExceededError", async () => {
    const tools = new ComsNetTools(toolCtx);

    // 0: allowed
    await tools.send({ target: "peer", prompt: "p0", hops: 0 });
    assert.equal(sentHops[0], 0);

    // 1: allowed
    await tools.send({ target: "peer", prompt: "p1", hops: 1 });
    assert.equal(sentHops[1], 1);

    // 4: allowed (boundary maximum)
    await tools.send({ target: "peer", prompt: "p4", hops: 4 });
    assert.equal(sentHops[2], 4);

    // 5: rejected
    await assert.rejects(
      () => tools.send({ target: "peer", prompt: "p5", hops: 5 }),
      HopLimitExceededError,
      "hops = 5 must throw HopLimitExceededError"
    );

    // 6: rejected
    await assert.rejects(
      () => tools.send({ target: "peer", prompt: "p6", hops: 6 }),
      HopLimitExceededError,
      "hops = 6 must throw HopLimitExceededError"
    );
  });

  it("identifies boundary behavior: non-standard hop inputs (-1, NaN, floats, Infinity)", async () => {
    const tools = new ComsNetTools(toolCtx);

    // hops = -1: -1 >= 5 is false, accepted by client check
    await tools.send({ target: "peer", prompt: "neg", hops: -1 });
    assert.equal(sentHops[sentHops.length - 1], -1);

    // hops = NaN: NaN >= 5 is false, accepted by client check
    await tools.send({ target: "peer", prompt: "nan", hops: NaN });
    assert.ok(Number.isNaN(sentHops[sentHops.length - 1]));

    // hops = 4.9: 4.9 >= 5 is false, accepted by client check
    await tools.send({ target: "peer", prompt: "float", hops: 4.9 });
    assert.equal(sentHops[sentHops.length - 1], 4.9);

    // hops = Infinity: Infinity >= 5 is true, rejected
    await assert.rejects(
      () => tools.send({ target: "peer", prompt: "inf", hops: Infinity }),
      HopLimitExceededError
    );
  });

  it("inbound-propagation: auto-increments and enforces hop limit across chained contexts", async () => {
    let currentInbound: InboundContext | null = null;
    toolCtx.inboundContextManager = {
      getCurrentInbound: () => currentInbound,
      setCurrentInbound: (ctx) => { currentInbound = ctx; },
      getInbound: () => undefined,
      removeInbound: () => {},
    };

    const tools = new ComsNetTools(toolCtx);

    // Inbound hops = 3 -> next send hops = 4 (allowed)
    currentInbound = {
      msg_id: "m1",
      hops: 3,
      sender_session: "s1",
      sender_name: "agent1",
      sender_cwd: "/cwd",
      prompt: "test",
      fulfilled: false,
    };
    const r1 = await tools.send({ target: "peer", prompt: "forward" });
    assert.equal(r1.details.hops, 4);

    // Inbound hops = 4 -> next send hops = 5 (must throw HopLimitExceededError)
    currentInbound = {
      msg_id: "m2",
      hops: 4,
      sender_session: "s2",
      sender_name: "agent2",
      sender_cwd: "/cwd",
      prompt: "test2",
      fulfilled: false,
    };
    await assert.rejects(
      () => tools.send({ target: "peer", prompt: "forward-loop" }),
      HopLimitExceededError
    );
  });
});

describe("Adversarial Probing: 4. 3-Way Race Resolution & Socket Leak Detection", () => {
  let server: http.Server;
  let serverPort: number;
  let openSockets = 0;
  let closedSockets = 0;
  let peakSockets = 0;

  before(async () => {
    server = http.createServer((req, res) => {
      openSockets++;
      peakSockets = Math.max(peakSockets, openSockets);

      req.on("close", () => {
        openSockets--;
        closedSockets++;
      });

      const url = new URL(req.url ?? "/", `http://127.0.0.1:${serverPort}`);
      if (url.pathname.includes("immediate")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ msg_id: "imm", status: "complete", response: "HTTP-immediate", error: null }));
        return;
      }

      // Default: simulate long-poll holding open until client aborts
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        serverPort = (server.address() as any).port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    openSockets = 0;
    closedSockets = 0;
    peakSockets = 0;
  });

  it("race-resolution: simultaneous arrival between SSE and HTTP resolves safely and aborts HTTP", async () => {
    const client = new ComsNetClient({
      baseUrl: `http://127.0.0.1:${serverPort}`,
      authToken: "test-tok",
    });
    const pendingReplies = new Map<string, PendingReply>();
    const tools = new ComsNetTools({
      client,
      identity: { session_id: "01J7SELF000000000000000001", name: "self", project: "default" },
      pendingReplies,
    });

    const msgId = "race-simul-msg";
    const awaitPromise = tools.await({ msg_id: msgId, timeout_ms: 2000 });

    // Deliver SSE after 20ms
    setTimeout(() => {
      const p = pendingReplies.get(msgId);
      p?.resolve({ response: "SSE-simultaneous", error: null });
    }, 20);

    const res = await awaitPromise;
    assert.equal(res.details.status, "complete");
    assert.equal(res.details.response, "SSE-simultaneous");

    // Allow socket abort to bubble
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(openSockets, 0, "HTTP long-poll socket must be closed when SSE wins");
  });

  it("rapid-cancellation: 30 concurrent awaits settling under short timeouts release all sockets cleanly", async () => {
    const client = new ComsNetClient({
      baseUrl: `http://127.0.0.1:${serverPort}`,
      authToken: "test-tok",
    });
    const pendingReplies = new Map<string, PendingReply>();
    const tools = new ComsNetTools({
      client,
      identity: { session_id: "01J7SELF000000000000000001", name: "self", project: "default" },
      pendingReplies,
    });

    const promises = Array.from({ length: 30 }, (_, i) =>
      tools.await({ msg_id: `rapid-${i}`, timeout_ms: 100 })
    );

    const results = await Promise.all(promises);
    for (const r of results) {
      assert.equal(r.details.status, "timeout");
      assert.equal(r.isError, true);
    }

    // Wait for TCP teardown
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(peakSockets, 30, "All 30 long-poll requests were established");
    assert.equal(openSockets, 0, "Zero socket leaks: all sockets aborted on client timeout");
    assert.equal(closedSockets, 30, "All 30 sockets cleanly closed");
  });

  it("sse-victory-release: 20 concurrent long-polls are all aborted when SSE replies arrive", async () => {
    const client = new ComsNetClient({
      baseUrl: `http://127.0.0.1:${serverPort}`,
      authToken: "test-tok",
    });
    const pendingReplies = new Map<string, PendingReply>();
    const tools = new ComsNetTools({
      client,
      identity: { session_id: "01J7SELF000000000000000001", name: "self", project: "default" },
      pendingReplies,
    });

    const promises = Array.from({ length: 20 }, async (_, i) => {
      const msgId = `sse-win-${i}`;
      const p = tools.await({ msg_id: msgId, timeout_ms: 5000 });
      setTimeout(() => {
        const pending = pendingReplies.get(msgId);
        pending?.resolve({ response: `reply-${i}`, error: null });
      }, 50);
      return p;
    });

    const results = await Promise.all(promises);
    for (let i = 0; i < 20; i++) {
      assert.equal(results[i].details.status, "complete");
      assert.equal(results[i].details.response, `reply-${i}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(peakSockets, 20, "20 concurrent sockets opened");
    assert.equal(openSockets, 0, "All 20 sockets aborted on SSE arrival");
    assert.equal(closedSockets, 20, "All 20 sockets closed");
  });

  it("lifecycle: probes pendingReplies memory accumulation over time", async () => {
    const client = new ComsNetClient({
      baseUrl: `http://127.0.0.1:${serverPort}`,
      authToken: "test-tok",
    });
    const pendingReplies = new Map<string, PendingReply>();
    const tools = new ComsNetTools({
      client,
      identity: { session_id: "01J7SELF000000000000000001", name: "self", project: "default" },
      pendingReplies,
    });

    for (let i = 0; i < 25; i++) {
      await tools.await({ msg_id: `immediate-${i}`, timeout_ms: 500 });
    }

    // Empirical observation: pendingReplies retains all 25 entries indefinitely
    assert.equal(pendingReplies.size, 25, "Entries are retained in pendingReplies indefinitely");
  });
});
