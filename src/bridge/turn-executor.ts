/**
 * src/bridge/turn-executor.ts
 *
 * Inbound turn execution engine for Antigravity CLI coms-net bridge.
 * Implements ITurnExecutor interface:
 * - AgyCliTurnExecutor: Headless child_process invocation of `agy -p`
 * - MockTurnExecutor: Hermetic in-memory mock for test suites
 * - Anti-loop prompt wrapping and schema validation helpers
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  InboundPromptEvent,
  TurnExecutionResult,
  ITurnExecutor,
} from "../protocol/types.ts";
import { redactToken } from "../protocol/errors.ts";

const execFileAsync = promisify(execFile);

export type { ITurnExecutor, InboundPromptEvent, TurnExecutionResult };

// ━━ Prompt Anti-Loop Formatter ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Injects anti-looping instruction warning into the inbound prompt.
 * Strictly prevents the model from calling coms_net_send to reply.
 */
export function formatInboundPrompt(
  senderName: string,
  senderCwd: string,
  msgId: string,
  promptText: string
): string {
  return (
    `[inbound coms-net message from ${senderName} @ ${senderCwd}]\n` +
    `[reply by writing a normal assistant message — your turn output is auto-returned to ${senderName}. ` +
    `DO NOT call coms_net_send/coms_net_await/coms_net_get to reply; that creates a ping-pong loop. ` +
    `msg_id ${msgId} belongs to ${senderName}'s outbound, not yours.]\n\n` +
    `${promptText}`
  );
}

// ━━ Schema Validation & JSON Extraction ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface SchemaValidationResult {
  payload: unknown;
  error: string | null;
}

/**
 * Validates and extracts structured response according to response_schema.
 * Supports direct JSON as well as Markdown codeblock extraction (```json ... ```).
 */
export function validateResponseSchema(
  rawResponse: string,
  responseSchema?: Record<string, unknown> | null
): SchemaValidationResult {
  if (!responseSchema || typeof responseSchema !== "object") {
    return { payload: rawResponse, error: null };
  }

  const trimmed = rawResponse.trim();

  // 1. Attempt direct JSON parse
  try {
    const parsed = JSON.parse(trimmed);
    return { payload: parsed, error: null };
  } catch {
    // Continue to fallback extraction
  }

  // 2. Attempt markdown code fence extraction (```json ... ``` or ``` ... ```)
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch && codeBlockMatch[1]) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      return { payload: parsed, error: null };
    } catch {
      // Continue to error return
    }
  }

  // 3. Fallback: Invalid JSON error per protocol_spec.md
  return {
    payload: null,
    error: "response not valid JSON",
  };
}

// ━━ Agy CLI Turn Executor ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface AgyCliTurnExecutorOptions {
  agyBinaryPath?: string;
  cwd?: string;
  model?: string;
  effort?: "low" | "medium" | "high";
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface AgyJsonOutput {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
}

export class AgyCliTurnExecutor implements ITurnExecutor {
  private readonly binaryPath: string;
  private readonly cwd: string;
  private readonly model?: string;
  private readonly effort?: "low" | "medium" | "high";
  private readonly timeoutMs: number;
  private readonly env?: NodeJS.ProcessEnv;

  constructor(options: AgyCliTurnExecutorOptions = {}) {
    this.binaryPath = options.agyBinaryPath || process.env.AGY_BIN_PATH || "agy";
    this.cwd = options.cwd || process.cwd();
    this.model = options.model;
    this.effort = options.effort;
    this.timeoutMs = options.timeoutMs ?? 300_000; // 5 minutes default
    this.env = options.env;
  }

  async execute(event: InboundPromptEvent): Promise<TurnExecutionResult> {
    const formattedPrompt = formatInboundPrompt(
      event.sender_name,
      "?",
      event.msg_id,
      event.prompt
    );

    const args = [
      "-p",
      formattedPrompt,
      "--output-format",
      "json",
      "--dangerously-skip-permissions",
    ];

    if (event.conversation_id) {
      args.push("--conversation", event.conversation_id);
    }
    if (this.model) {
      args.push("--model", this.model);
    }
    if (this.effort) {
      args.push("--effort", this.effort);
    }
    if (this.timeoutMs > 0) {
      args.push("--print-timeout", `${Math.ceil(this.timeoutMs / 1000)}s`);
    }

    try {
      const { stdout, stderr } = await execFileAsync(this.binaryPath, args, {
        cwd: this.cwd,
        timeout: this.timeoutMs,
        maxBuffer: 20 * 1024 * 1024, // 20 MB
        env: {
          ...process.env,
          ...this.env,
        },
      });

      return this.parseOutput(stdout, stderr);
    } catch (err: unknown) {
      const errorObj = err as {
        message?: string;
        code?: string | number;
        killed?: boolean;
        stderr?: string;
        stdout?: string;
      };

      if (errorObj?.killed) {
        return {
          response: "",
          error: `Turn execution timed out after ${this.timeoutMs}ms`,
        };
      }

      // Check if stdout contained structured error JSON despite non-zero exit
      if (errorObj?.stdout) {
        try {
          return this.parseOutput(errorObj.stdout, errorObj.stderr || "");
        } catch {
          // Fall through to generic error
        }
      }

      const errorMsg = errorObj?.stderr?.trim() || errorObj?.message || "Subprocess execution failed";
      return {
        response: "",
        error: redactToken(errorMsg),
      };
    }
  }

  private parseOutput(stdout: string, stderr: string): TurnExecutionResult {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return {
        response: "",
        error: stderr.trim() || "Empty output from Antigravity CLI",
      };
    }

    // Robust JSON substring extraction
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return {
        response: trimmed,
        error: "Unparseable non-JSON output from Antigravity CLI",
      };
    }

    const jsonStr = trimmed.slice(firstBrace, lastBrace + 1);
    let parsed: AgyJsonOutput;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      return {
        response: trimmed,
        error: `Malformed JSON from Antigravity CLI: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    if (parsed.status && parsed.status !== "SUCCESS") {
      return {
        response: parsed.response || "",
        error: parsed.error || parsed.response || `Turn completed with status: ${parsed.status}`,
        conversation_id: parsed.conversation_id,
        duration_seconds: parsed.duration_seconds,
        usage: parsed.usage,
      };
    }

    return {
      response: parsed.response || "",
      conversation_id: parsed.conversation_id,
      duration_seconds: parsed.duration_seconds,
      usage: parsed.usage,
    };
  }
}

// ━━ Hermetic Mock Turn Executor ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type MockTurnHandler = (
  event: InboundPromptEvent
) => Promise<TurnExecutionResult> | TurnExecutionResult;

export interface MockTurnExecutorOptions {
  handler?: MockTurnHandler;
  defaultResponse?: string;
  delayMs?: number;
  error?: string;
}

export class MockTurnExecutor implements ITurnExecutor {
  private handler?: MockTurnHandler;
  private defaultResponse: string;
  private delayMs: number;
  private error?: string;
  public readonly executedEvents: InboundPromptEvent[] = [];

  constructor(options: MockTurnExecutorOptions = {}) {
    this.handler = options.handler;
    this.defaultResponse = options.defaultResponse ?? "Mock response from Antigravity agent";
    this.delayMs = options.delayMs ?? 0;
    this.error = options.error;
  }

  setHandler(handler: MockTurnHandler): void {
    this.handler = handler;
  }

  setDefaultResponse(response: string): void {
    this.defaultResponse = response;
  }

  setError(error?: string): void {
    this.error = error;
  }

  async execute(event: InboundPromptEvent): Promise<TurnExecutionResult> {
    this.executedEvents.push(event);

    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    if (this.error) {
      return {
        response: "",
        error: this.error,
      };
    }

    if (this.handler) {
      return this.handler(event);
    }

    return {
      response: this.defaultResponse,
      duration_seconds: 0.1,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
      },
    };
  }
}
