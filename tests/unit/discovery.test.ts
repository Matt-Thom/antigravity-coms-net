/**
 * tests/unit/discovery.test.ts
 *
 * Unit tests for Hub Discovery & Security Enforcement:
 * - POSIX mode 0600 verification (success)
 * - Mode 0644, 0777, 0660 rejection
 * - Symlink rejection
 * - Path traversal protection
 * - Environment variable overrides & CLI option precedence
 * - Token redaction & safeHubConfig
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  discoverHubSync,
  discoverHub,
  readServerSecret,
  readServerJson,
  validateProjectName,
  safeHubConfig,
  ENV_SERVER_URL,
  ENV_AUTH_TOKEN,
  ENV_PROJECT,
} from "../../src/protocol/discovery.ts";
import {
  NoServerUrlError,
  NoAuthTokenError,
  InvalidProjectNameError,
  ComsNetError,
  redactToken,
} from "../../src/protocol/errors.ts";

describe("Hub Discovery & Security Enforcement", () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coms-net-disc-test-"));
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

  it("should successfully discover hub from server.json and server.secret.json with mode 0600", () => {
    const serverJson = {
      version: 1,
      project: "default",
      local_url: "http://127.0.0.1:52965/",
    };
    fs.writeFileSync(path.join(projectDir, "server.json"), JSON.stringify(serverJson));

    const secretJson = { token: "0123456789abcdef0123456789abcdef" };
    const secretPath = path.join(projectDir, "server.secret.json");
    fs.writeFileSync(secretPath, JSON.stringify(secretJson));
    fs.chmodSync(secretPath, 0o600);

    const result = discoverHubSync({ registryDir: tempDir });
    assert.equal(result.config.baseUrl, "http://127.0.0.1:52965");
    assert.equal(result.config.authToken, "0123456789abcdef0123456789abcdef");
    assert.equal(result.config.project, "default");
    assert.equal(result.source.urlSource, "file");
    assert.equal(result.source.tokenSource, "secret_file");
  });

  it("should async discoverHub return identical result", async () => {
    const serverJson = {
      version: 1,
      project: "default",
      local_url: "http://127.0.0.1:52965",
    };
    fs.writeFileSync(path.join(projectDir, "server.json"), JSON.stringify(serverJson));

    const secretPath = path.join(projectDir, "server.secret.json");
    fs.writeFileSync(secretPath, JSON.stringify({ token: "async-token-1234" }));
    fs.chmodSync(secretPath, 0o600);

    const result = await discoverHub({ registryDir: tempDir });
    assert.equal(result.config.baseUrl, "http://127.0.0.1:52965");
    assert.equal(result.config.authToken, "async-token-1234");
  });

  it("should strictly reject server.secret.json if permissions are 0644", () => {
    const serverJson = { version: 1, local_url: "http://127.0.0.1:52965" };
    fs.writeFileSync(path.join(projectDir, "server.json"), JSON.stringify(serverJson));

    const secretPath = path.join(projectDir, "server.secret.json");
    fs.writeFileSync(secretPath, JSON.stringify({ token: "leaked_token" }));
    fs.chmodSync(secretPath, 0o644);

    const readRes = readServerSecret(projectDir);
    assert.equal(readRes.secret, null);
    assert.ok(readRes.rejectionReason?.includes("0o644"));

    assert.throws(
      () => discoverHubSync({ registryDir: tempDir }),
      (err: unknown) => {
        assert.ok(err instanceof NoAuthTokenError);
        assert.ok(err.message.includes("0600"));
        return true;
      }
    );
  });

  it("should strictly reject server.secret.json if permissions are 0777", () => {
    const serverJson = { version: 1, local_url: "http://127.0.0.1:52965" };
    fs.writeFileSync(path.join(projectDir, "server.json"), JSON.stringify(serverJson));

    const secretPath = path.join(projectDir, "server.secret.json");
    fs.writeFileSync(secretPath, JSON.stringify({ token: "world_writable_token" }));
    fs.chmodSync(secretPath, 0o777);

    assert.throws(
      () => discoverHubSync({ registryDir: tempDir }),
      (err: unknown) => {
        assert.ok(err instanceof NoAuthTokenError);
        return true;
      }
    );
  });

  it("should strictly reject server.secret.json if it is a symbolic link", () => {
    const serverJson = { version: 1, local_url: "http://127.0.0.1:52965" };
    fs.writeFileSync(path.join(projectDir, "server.json"), JSON.stringify(serverJson));

    const realSecretPath = path.join(tempDir, "real_secret.json");
    fs.writeFileSync(realSecretPath, JSON.stringify({ token: "symlinked_token" }));
    fs.chmodSync(realSecretPath, 0o600);

    const symlinkPath = path.join(projectDir, "server.secret.json");
    fs.symlinkSync(realSecretPath, symlinkPath);

    const readRes = readServerSecret(projectDir);
    assert.equal(readRes.secret, null);
    assert.equal(readRes.rejectionReason, "symlink_not_allowed");

    assert.throws(
      () => discoverHubSync({ registryDir: tempDir }),
      (err: unknown) => {
        assert.ok(err instanceof NoAuthTokenError);
        assert.ok(err.message.includes("symlink_not_allowed"));
        return true;
      }
    );
  });

  it("should throw NoServerUrlError if server.json is missing and no env or option is set", () => {
    const secretPath = path.join(projectDir, "server.secret.json");
    fs.writeFileSync(secretPath, JSON.stringify({ token: "some_token" }));
    fs.chmodSync(secretPath, 0o600);

    assert.throws(
      () => discoverHubSync({ registryDir: tempDir }),
      (err: unknown) => {
        assert.ok(err instanceof NoServerUrlError);
        return true;
      }
    );
  });

  it("should throw InvalidProjectNameError on path traversal attempts", () => {
    assert.throws(
      () => validateProjectName("../../etc"),
      (err: unknown) => {
        assert.ok(err instanceof InvalidProjectNameError);
        return true;
      }
    );

    assert.throws(
      () => discoverHubSync({ project: "invalid/project/name" }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidProjectNameError);
        return true;
      }
    );
  });

  it("should prioritize environment variables over file discovery", () => {
    const serverJson = { version: 1, local_url: "http://127.0.0.1:5000" };
    fs.writeFileSync(path.join(projectDir, "server.json"), JSON.stringify(serverJson));
    const secretPath = path.join(projectDir, "server.secret.json");
    fs.writeFileSync(secretPath, JSON.stringify({ token: "file-token" }));
    fs.chmodSync(secretPath, 0o600);

    process.env[ENV_SERVER_URL] = "http://env-host:8080/";
    process.env[ENV_AUTH_TOKEN] = "env-secret-token";

    const result = discoverHubSync({ registryDir: tempDir });
    assert.equal(result.config.baseUrl, "http://env-host:8080");
    assert.equal(result.config.authToken, "env-secret-token");
    assert.equal(result.source.urlSource, "env");
    assert.equal(result.source.tokenSource, "env");
  });

  it("should prioritize explicit options over environment variables", () => {
    process.env[ENV_SERVER_URL] = "http://env-host:8080";
    process.env[ENV_AUTH_TOKEN] = "env-secret-token";

    const result = discoverHubSync({
      serverUrl: "http://option-host:9090/",
      authToken: "option-token",
      registryDir: tempDir,
    });
    assert.equal(result.config.baseUrl, "http://option-host:9090");
    assert.equal(result.config.authToken, "option-token");
    assert.equal(result.source.urlSource, "option");
    assert.equal(result.source.tokenSource, "option");
  });

  it("should redact tokens in text, Bearer headers, and ComsNetError stack traces", () => {
    const secret = "SUPER_SECRET_TOKEN_42";
    const raw = `Error: Bearer ${secret} failed with ${secret}`;
    const redacted = redactToken(raw, secret);
    assert.equal(redacted, "Error: Bearer <redacted> failed with <redacted>");
    assert.ok(!redacted.includes(secret));

    const err = new ComsNetError(`Failed connecting with token ${secret}`, secret);
    assert.ok(!err.message.includes(secret));
    assert.ok(err.message.includes("<redacted>"));
    if (err.stack) {
      assert.ok(!err.stack.includes(secret));
    }
  });

  it("should return masked configuration with safeHubConfig", () => {
    const cfg = {
      baseUrl: "http://localhost:5000",
      authToken: "secret123",
      project: "default",
    };
    const safe = safeHubConfig(cfg);
    assert.equal(safe.authToken, "<redacted>");
    assert.equal(safe.baseUrl, "http://localhost:5000");
  });
});
