/**
 * tests/unit/cli.test.ts
 *
 * Automated test suite for CLI entrypoint, argument parsing, wrapper scripts,
 * and package distribution scripts.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { parseCliArgs, getHelpText, getVersion } from "../../src/cli.ts";
import { MockHub } from "../mocks/mock-hub.ts";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

describe("CLI Tooling & Distribution Tests", () => {
  describe("Argument Parser (parseCliArgs)", () => {
    it("should parse default arguments correctly", () => {
      const args = parseCliArgs([]);
      assert.strictEqual(args.mock, false);
      assert.strictEqual(args.help, false);
      assert.strictEqual(args.version, false);
      assert.strictEqual(args.project, undefined);
      assert.strictEqual(args.serverUrl, undefined);
      assert.strictEqual(args.name, undefined);
    });

    it("should parse short flags (-p, -u, -t, -n, -m, -h, -v)", () => {
      const args = parseCliArgs([
        "-p", "my-project",
        "-u", "http://localhost:1234",
        "-t", "test-token",
        "-n", "agent-bob",
        "-m", "gemini-3.7-flash-high",
      ]);
      assert.strictEqual(args.project, "my-project");
      assert.strictEqual(args.serverUrl, "http://localhost:1234");
      assert.strictEqual(args.authToken, "test-token");
      assert.strictEqual(args.name, "agent-bob");
      assert.strictEqual(args.model, "gemini-3.7-flash-high");
    });

    it("should parse long flags including --mock and --mock-response", () => {
      const args = parseCliArgs([
        "--mock",
        "--mock-response", "Custom canned output",
        "--max-turns", "4",
        "--heartbeat-ms", "5000",
        "--cwd", "/tmp",
        "--explicit",
      ]);
      assert.strictEqual(args.mock, true);
      assert.strictEqual(args.mockResponse, "Custom canned output");
      assert.strictEqual(args.maxTurns, 4);
      assert.strictEqual(args.heartbeatMs, 5000);
      assert.strictEqual(args.cwd, "/tmp");
      assert.strictEqual(args.explicit, true);
    });

    it("should parse --help and --version", () => {
      assert.strictEqual(parseCliArgs(["-h"]).help, true);
      assert.strictEqual(parseCliArgs(["--help"]).help, true);
      assert.strictEqual(parseCliArgs(["-v"]).version, true);
      assert.strictEqual(parseCliArgs(["--version"]).version, true);
    });

    it("should reject invalid, non-numeric, or non-positive --max-turns", () => {
      assert.throws(
        () => parseCliArgs(["--max-turns", "abc"]),
        /must be a positive integer/
      );
      assert.throws(
        () => parseCliArgs(["--max-turns", "0"]),
        /must be a positive integer/
      );
      assert.throws(
        () => parseCliArgs(["--max-turns=-5"]),
        /must be a positive integer/
      );
    });

    it("should reject invalid, non-numeric, or non-positive --heartbeat-ms", () => {
      assert.throws(
        () => parseCliArgs(["--heartbeat-ms", "xyz"]),
        /must be a positive integer/
      );
      assert.throws(
        () => parseCliArgs(["--heartbeat-ms", "0"]),
        /must be a positive integer/
      );
      assert.throws(
        () => parseCliArgs(["--heartbeat-ms=-100"]),
        /must be a positive integer/
      );
    });
  });

  describe("Help & Version Strings", () => {
    it("should produce non-empty help text containing all flags and examples", () => {
      const help = getHelpText();
      assert.ok(help.includes("coms-net-bridge"));
      assert.ok(help.includes("--project"));
      assert.ok(help.includes("--server-url"));
      assert.ok(help.includes("--mock"));
      assert.ok(help.includes("EXAMPLES:"));
    });

    it("should produce valid semantic version string matching package.json", () => {
      const version = getVersion();
      assert.match(version, /^\d+\.\d+\.\d+/);
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"));
      assert.strictEqual(version, pkg.version);
    });
  });

  describe("Executable Wrapper Scripts (bin/)", () => {
    const bridgeScript = path.join(REPO_ROOT, "bin", "coms-net-bridge.js");
    const mcpScript = path.join(REPO_ROOT, "bin", "coms-net-mcp.js");

    it("bin/coms-net-bridge.js should exist, be executable, and have node shebang", () => {
      assert.ok(fs.existsSync(bridgeScript), "bin/coms-net-bridge.js must exist");
      const content = fs.readFileSync(bridgeScript, "utf-8");
      assert.ok(content.startsWith("#!/usr/bin/env node"), "Must have #!/usr/bin/env node shebang");
      const stat = fs.statSync(bridgeScript);
      const isExecutable = (stat.mode & 0o111) !== 0;
      assert.ok(isExecutable, "bin/coms-net-bridge.js must be executable (chmod +x)");
    });

    it("bin/coms-net-mcp.js should exist, be executable, and have node shebang", () => {
      assert.ok(fs.existsSync(mcpScript), "bin/coms-net-mcp.js must exist");
      const content = fs.readFileSync(mcpScript, "utf-8");
      assert.ok(content.startsWith("#!/usr/bin/env node"), "Must have #!/usr/bin/env node shebang");
      const stat = fs.statSync(mcpScript);
      const isExecutable = (stat.mode & 0o111) !== 0;
      assert.ok(isExecutable, "bin/coms-net-mcp.js must be executable (chmod +x)");
    });

    it("should execute bin/coms-net-bridge.js --version and exit 0", async () => {
      const { stdout } = await execFileAsync(bridgeScript, ["--version"]);
      assert.ok(stdout.includes("coms-net-bridge v"));
    });

    it("should execute bin/coms-net-bridge.js --help and exit 0", async () => {
      const { stdout } = await execFileAsync(bridgeScript, ["--help"]);
      assert.ok(stdout.includes("USAGE:"));
      assert.ok(stdout.includes("OPTIONS:"));
    });
  });

  describe("Bridge Daemon CLI Subprocess Boot & Graceful Exit", () => {
    let hub: MockHub;

    before(async () => {
      hub = new MockHub();
      await hub.start();
    });

    after(async () => {
      await hub.stop();
    });

    it("should boot bridge daemon via CLI in mock mode and shut down cleanly on SIGINT", async () => {
      const bridgeScript = path.join(REPO_ROOT, "bin", "coms-net-bridge.js");
      const child = spawn(bridgeScript, [
        "--server-url", hub.baseUrl,
        "--auth-token", hub.token,
        "--project", "cli-test",
        "--name", "cli-mock-worker",
        "--mock",
        "--mock-response", "Hello from CLI mock",
      ]);

      let output = "";
      child.stdout.on("data", (d) => { output += d.toString(); });
      child.stderr.on("data", (d) => { output += d.toString(); });

      // Wait until registered and SSE connected
      const started = await new Promise<boolean>((resolve) => {
        const checkInterval = setInterval(() => {
          if (output.includes("Agent registered: cli-mock-worker") && output.includes("SSE event stream connected")) {
            clearInterval(checkInterval);
            resolve(true);
          }
        }, 50);

        setTimeout(() => {
          clearInterval(checkInterval);
          resolve(false);
        }, 5000);
      });

      assert.ok(started, `Daemon failed to start in time. Output:\n${output}`);

      // Verify presence in MockHub registry
      const project = hub.getProject("cli-test");
      let foundSessionId = "";
      for (const [id, agent] of project.agents.entries()) {
        if (agent.name === "cli-mock-worker") {
          foundSessionId = id;
          break;
        }
      }
      assert.ok(foundSessionId, "Agent must be registered in hub");

      // Dispatch SIGINT
      child.kill("SIGINT");

      const exitCode = await new Promise<number>((resolve) => {
        child.on("exit", (code) => resolve(code ?? 0));
      });

      assert.strictEqual(exitCode, 0, "Process must exit cleanly with code 0");

      // Verify agent was removed from hub registry
      assert.strictEqual(project.agents.has(foundSessionId), false, "Agent must unregister on exit");
    });
  });

  describe("package.json Configuration", () => {
    it("should have correct bin mappings and scripts", () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"));
      assert.strictEqual(pkg.bin["coms-net-bridge"], "./bin/coms-net-bridge.js");
      assert.strictEqual(pkg.bin["coms-net-mcp"], "./bin/coms-net-mcp.js");
      assert.strictEqual(pkg.scripts["bridge"], "tsx src/cli.ts");
      assert.strictEqual(pkg.scripts["mcp"], "tsx src/mcp/server.ts");
      assert.strictEqual(pkg.scripts["validate:plugin"], "agy plugin validate .agents/plugins/coms-net");
    });
  });
});
