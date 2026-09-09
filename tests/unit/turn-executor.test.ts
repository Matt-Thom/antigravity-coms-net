/**
 * tests/unit/turn-executor.test.ts
 *
 * Comprehensive unit tests for formatInboundPrompt, validateResponseSchema,
 * MockTurnExecutor, and AgyCliTurnExecutor.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  formatInboundPrompt,
  validateResponseSchema,
  MockTurnExecutor,
  AgyCliTurnExecutor,
} from "../../src/bridge/turn-executor.ts";
import type { InboundPromptEvent } from "../../src/protocol/types.ts";

describe("formatInboundPrompt Anti-Looping Envelope Tests", () => {
  it("F1: should format prompt with anti-looping instruction envelope", () => {
    const formatted = formatInboundPrompt(
      "pi-coder",
      "/home/matt/pi-project",
      "01JM78XYZ456789ABCDEFGHJKM",
      "Please review the PR and check tests."
    );

    assert.ok(formatted.includes("[inbound coms-net message from pi-coder @ /home/matt/pi-project]"));
    assert.ok(formatted.includes("DO NOT call coms_net_send/coms_net_await/coms_net_get to reply; that creates a ping-pong loop."));
    assert.ok(formatted.includes("msg_id 01JM78XYZ456789ABCDEFGHJKM belongs to pi-coder's outbound, not yours."));
    assert.ok(formatted.endsWith("Please review the PR and check tests."));
  });
});

describe("validateResponseSchema Tests", () => {
  it("S1: should bypass validation and return raw string when response_schema is null or omitted", () => {
    const r1 = validateResponseSchema("Hello world", null);
    assert.strictEqual(r1.payload, "Hello world");
    assert.strictEqual(r1.error, null);

    const r2 = validateResponseSchema("Just freeform text", undefined);
    assert.strictEqual(r2.payload, "Just freeform text");
    assert.strictEqual(r2.error, null);
  });

  it("S2: should parse direct valid JSON when response_schema is present", () => {
    const schema = { type: "object", properties: { result: { type: "string" } } };
    const raw = '{"result": "success", "count": 42}';

    const r = validateResponseSchema(raw, schema);
    assert.deepStrictEqual(r.payload, { result: "success", count: 42 });
    assert.strictEqual(r.error, null);
  });

  it("S3: should extract JSON from markdown codeblock (```json ... ```)", () => {
    const schema = { type: "object" };
    const raw = `Here is the requested analysis:
\`\`\`json
{
  "status": "APPROVED",
  "issues": []
}
\`\`\`
Hope this helps!`;

    const r = validateResponseSchema(raw, schema);
    assert.deepStrictEqual(r.payload, { status: "APPROVED", issues: [] });
    assert.strictEqual(r.error, null);
  });

  it("S4: should extract JSON from markdown codeblock without json tag (``` ... ```)", () => {
    const schema = { type: "object" };
    const raw = `\`\`\`
{
  "code": 200,
  "ok": true
}
\`\`\``;

    const r = validateResponseSchema(raw, schema);
    assert.deepStrictEqual(r.payload, { code: 200, ok: true });
    assert.strictEqual(r.error, null);
  });

  it("S5: should return 'response not valid JSON' error when text is not valid JSON", () => {
    const schema = { type: "object" };
    const raw = "I am unable to output JSON, sorry!";

    const r = validateResponseSchema(raw, schema);
    assert.strictEqual(r.payload, null);
    assert.strictEqual(r.error, "response not valid JSON");
  });
});

describe("MockTurnExecutor Tests", () => {
  const sampleEvent: InboundPromptEvent = {
    msg_id: "01JMTESTMSG000000000000001",
    sender_session: "01JMSENDER000000000000001",
    sender_name: "test-sender",
    sender_project: "default",
    prompt: "Test prompt execution",
    hops: 0,
  };

  it("M1: should return default canned response and record executed events", async () => {
    const executor = new MockTurnExecutor({
      defaultResponse: "Canned mock response",
    });

    const result = await executor.execute(sampleEvent);
    assert.strictEqual(result.response, "Canned mock response");
    assert.strictEqual(result.error, undefined);
    assert.ok(result.usage);
    assert.strictEqual(result.usage.total_tokens, 150);
    assert.strictEqual(executor.executedEvents.length, 1);
    assert.strictEqual(executor.executedEvents[0].msg_id, sampleEvent.msg_id);
  });

  it("M2: should execute dynamic custom handler", async () => {
    const executor = new MockTurnExecutor();
    executor.setHandler(async (event) => ({
      response: `Echo: ${event.prompt}`,
      duration_seconds: 0.5,
    }));

    const result = await executor.execute(sampleEvent);
    assert.strictEqual(result.response, "Echo: Test prompt execution");
    assert.strictEqual(result.duration_seconds, 0.5);
  });

  it("M3: should support simulated delay and error injection", async () => {
    const executor = new MockTurnExecutor({
      delayMs: 20,
      error: "Simulated turn failure",
    });

    const start = Date.now();
    const result = await executor.execute(sampleEvent);
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 15, "Delay should be respected");
    assert.strictEqual(result.response, "");
    assert.strictEqual(result.error, "Simulated turn failure");
  });
});

describe("AgyCliTurnExecutor Parsing & Execution Tests", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-"));

  it("A1: should parse successful output from mock agy CLI script", async () => {
    // Create a mock executable script mimicking `agy -p --output-format json`
    const mockAgyPath = path.join(tmpDir, "mock-agy.sh");
    fs.writeFileSync(
      mockAgyPath,
      `#!/bin/bash
cat << 'JSON_EOF'
{
  "conversation_id": "conv-test-123",
  "status": "SUCCESS",
  "response": "Antigravity CLI completed successfully.",
  "duration_seconds": 1.25,
  "num_turns": 1,
  "usage": {
    "input_tokens": 500,
    "output_tokens": 100,
    "thinking_tokens": 20,
    "total_tokens": 620
  }
}
JSON_EOF
`,
      { mode: 0o755 }
    );

    const executor = new AgyCliTurnExecutor({
      agyBinaryPath: mockAgyPath,
      cwd: tmpDir,
      timeoutMs: 5000,
    });

    const event: InboundPromptEvent = {
      msg_id: "01JMEXEC00000000000000001",
      sender_session: "sender-sid",
      sender_name: "sender-name",
      sender_project: "default",
      prompt: "Run mock task",
      hops: 0,
    };

    const res = await executor.execute(event);
    assert.strictEqual(res.response, "Antigravity CLI completed successfully.");
    assert.strictEqual(res.conversation_id, "conv-test-123");
    assert.strictEqual(res.duration_seconds, 1.25);
    assert.strictEqual(res.usage?.total_tokens, 620);
    assert.strictEqual(res.error, undefined);
  });

  it("A2: should extract JSON even if stdout contains surrounding non-JSON noise", async () => {
    const mockNoisePath = path.join(tmpDir, "mock-agy-noise.sh");
    fs.writeFileSync(
      mockNoisePath,
      `#!/bin/bash
echo "[DEBUG] Loading plugins..."
echo "[INFO] Connected to agent network."
cat << 'JSON_EOF'
{
  "conversation_id": "conv-noise-456",
  "status": "SUCCESS",
  "response": "Noise-tolerant response.",
  "duration_seconds": 0.8
}
JSON_EOF
echo "[DEBUG] Turn execution cleanup complete."
`,
      { mode: 0o755 }
    );

    const executor = new AgyCliTurnExecutor({
      agyBinaryPath: mockNoisePath,
      cwd: tmpDir,
    });

    const event: InboundPromptEvent = {
      msg_id: "01JMEXEC00000000000000002",
      sender_session: "sender-sid",
      sender_name: "sender-name",
      sender_project: "default",
      prompt: "Noise test",
      hops: 0,
    };

    const res = await executor.execute(event);
    assert.strictEqual(res.response, "Noise-tolerant response.");
    assert.strictEqual(res.conversation_id, "conv-noise-456");
  });

  it("A3: should extract error when status is not SUCCESS", async () => {
    const mockErrPath = path.join(tmpDir, "mock-agy-err.sh");
    fs.writeFileSync(
      mockErrPath,
      `#!/bin/bash
cat << 'JSON_EOF'
{
  "conversation_id": "conv-err-789",
  "status": "ERROR",
  "error": "Model quota exhausted",
  "response": ""
}
JSON_EOF
`,
      { mode: 0o755 }
    );

    const executor = new AgyCliTurnExecutor({
      agyBinaryPath: mockErrPath,
      cwd: tmpDir,
    });

    const event: InboundPromptEvent = {
      msg_id: "01JMEXEC00000000000000003",
      sender_session: "sender-sid",
      sender_name: "sender-name",
      sender_project: "default",
      prompt: "Error test",
      hops: 0,
    };

    const res = await executor.execute(event);
    assert.strictEqual(res.error, "Model quota exhausted");
  });

  it("A4: should handle timeout cleanly", async () => {
    const mockSleepPath = path.join(tmpDir, "mock-agy-sleep.sh");
    fs.writeFileSync(
      mockSleepPath,
      `#!/bin/bash
sleep 2
`,
      { mode: 0o755 }
    );

    const executor = new AgyCliTurnExecutor({
      agyBinaryPath: mockSleepPath,
      cwd: tmpDir,
      timeoutMs: 100, // 100ms timeout
    });

    const event: InboundPromptEvent = {
      msg_id: "01JMEXEC00000000000000004",
      sender_session: "sender-sid",
      sender_name: "sender-name",
      sender_project: "default",
      prompt: "Timeout test",
      hops: 0,
    };

    const res = await executor.execute(event);
    assert.ok(res.error?.includes("timed out after 100ms"));
  });
});
