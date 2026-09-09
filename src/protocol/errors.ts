/**
 * src/protocol/errors.ts
 *
 * Typed error taxonomy with zero-leak token redaction for coms-net.
 */

import * as util from "node:util";

// ── Redaction Utilities ─────────────────────────────────────────────────────

/**
 * Strips known raw tokens, Bearer authorization patterns, and json token fields
 * from input text to ensure credentials are never leaked.
 */
export function redactToken(text: string, token?: string): string {
  if (!text) return text;
  let result = text;
  if (token && token.length > 0) {
    result = result.split(token).join("<redacted>");
  }
  // Scrub Bearer token formats
  result = result.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, "Bearer <redacted>");
  // Scrub JSON "token": "..." formats
  result = result.replace(/(["']?token["']?\s*[:=]\s*["'])[0-9a-fA-F]{16,128}(["'])/gi, "$1<redacted>$2");
  return result;
}

// ── Base Error Class ────────────────────────────────────────────────────────

export class ComsNetError extends Error {
  public readonly code?: string;

  constructor(message: string, token?: string, code?: string) {
    super(redactToken(message, token));
    this.name = "ComsNetError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);

    if (this.stack) {
      this.stack = redactToken(this.stack, token);
    }
  }

  [util.inspect.custom](): string {
    return `${this.name}: ${this.message}`;
  }
}

// ── Discovery Errors ────────────────────────────────────────────────────────

export class HubDiscoveryError extends ComsNetError {
  constructor(message: string, code = "DISCOVERY_ERROR", token?: string) {
    super(message, token, code);
    this.name = "HubDiscoveryError";
  }
}

export class NoServerUrlError extends HubDiscoveryError {
  constructor(project: string, searchPath: string) {
    super(
      `coms-net: unable to determine server URL for project '${project}'.\n` +
      `Ensure the hub is running, provide --server-url, set PI_COMS_NET_SERVER_URL, ` +
      `or verify that ${searchPath} exists.`,
      "NO_SERVER_URL"
    );
    this.name = "NoServerUrlError";
  }
}

export class NoAuthTokenError extends HubDiscoveryError {
  constructor(project: string, searchPath: string, reason?: string) {
    const extra = reason ? ` (${reason})` : "";
    super(
      `coms-net: unable to determine auth token for project '${project}'.\n` +
      `Provide --auth-token, set PI_COMS_NET_AUTH_TOKEN, or ensure ${searchPath} ` +
      `exists with strict permissions 0600${extra}.`,
      "NO_AUTH_TOKEN"
    );
    this.name = "NoAuthTokenError";
  }
}

export class InvalidProjectNameError extends HubDiscoveryError {
  constructor(project: string) {
    super(
      `coms-net: invalid project name '${project}'. Project names must only contain ` +
      `alphanumeric characters, hyphens, and underscores (^[a-zA-Z0-9_-]+$).`,
      "INVALID_PROJECT_NAME"
    );
    this.name = "InvalidProjectNameError";
  }
}

// ── Network & Transport Errors ──────────────────────────────────────────────

export class ConnectionRefusedError extends ComsNetError {
  readonly url: string;
  readonly cause?: Error;

  constructor(url: string, cause?: Error, token?: string) {
    super(`Failed to connect to coms-net hub at ${url}: connection refused`, token, "CONNECTION_REFUSED");
    this.name = "ConnectionRefusedError";
    this.url = url;
    this.cause = cause;
  }
}

export class RequestTimeoutError extends ComsNetError {
  readonly method: string;
  readonly url: string;
  readonly timeoutMs: number;

  constructor(method: string, url: string, timeoutMs: number, token?: string) {
    super(`Request ${method} ${url} timed out after ${timeoutMs}ms`, token, "REQUEST_TIMEOUT");
    this.name = "RequestTimeoutError";
    this.method = method;
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

// ── HTTP Errors ─────────────────────────────────────────────────────────────

export class ComsNetHttpError extends ComsNetError {
  readonly status: number;
  readonly errorCode: string;
  readonly details?: unknown;
  readonly method: string;
  readonly url: string;

  constructor(
    status: number,
    errorCode: string,
    details: unknown,
    method: string,
    url: string,
    message?: string,
    token?: string
  ) {
    const desc = message ?? `HTTP ${status} (${errorCode}) during ${method} ${url}`;
    super(desc, token, errorCode);
    this.name = "ComsNetHttpError";
    this.status = status;
    this.errorCode = errorCode;
    this.details = details;
    this.method = method;
    this.url = url;
  }
}

/** 401 Unauthorized: Invalid or missing Bearer token */
export class UnauthorizedError extends ComsNetHttpError {
  constructor(status: number, errorCode: string, details: unknown, method: string, url: string, token?: string) {
    super(status, errorCode, details, method, url, "Unauthorized: invalid or missing authentication token", token);
    this.name = "UnauthorizedError";
  }
}

/** 403 Forbidden: Submitting responder session does not match msg.target_session */
export class NotTargetError extends ComsNetHttpError {
  constructor(status: number, errorCode: string, details: unknown, method: string, url: string, token?: string) {
    super(status, errorCode, details, method, url, "Forbidden: responder session is not the target of this message", token);
    this.name = "NotTargetError";
  }
}

/** 404 Not Found: Target agent not found in project pool */
export class TargetNotFoundError extends ComsNetHttpError {
  readonly target?: string;

  constructor(status: number, errorCode: string, details: unknown, method: string, url: string, token?: string) {
    const target = (details as { target?: string } | undefined)?.target;
    super(status, errorCode, details, method, url, `Target agent not found${target ? `: "${target}"` : ""}`, token);
    this.name = "TargetNotFoundError";
    this.target = target;
  }
}

/** 404 Not Found: Agent session not registered or project not found */
export class AgentNotFoundError extends ComsNetHttpError {
  constructor(status: number, errorCode: string, details: unknown, method: string, url: string, token?: string) {
    super(status, errorCode, details, method, url, "Agent session not found in registry", token);
    this.name = "AgentNotFoundError";
  }
}

/** 404 Not Found: Sender session is not registered in project */
export class SenderNotRegisteredError extends ComsNetHttpError {
  constructor(status: number, errorCode: string, details: unknown, method: string, url: string, token?: string) {
    super(status, errorCode, details, method, url, "Sender session is not registered in hub", token);
    this.name = "SenderNotRegisteredError";
  }
}

/** 404 Not Found: Message ID not found in hub memory */
export class MessageNotFoundError extends ComsNetHttpError {
  readonly msgId?: string;

  constructor(status: number, errorCode: string, details: unknown, method: string, url: string, msgId?: string, token?: string) {
    super(status, errorCode, details, method, url, `Message not found${msgId ? `: ${msgId}` : ""}`, token);
    this.name = "MessageNotFoundError";
    this.msgId = msgId;
  }
}

/** 409 Conflict: Target friendly name matches multiple online sessions */
export class AmbiguousTargetError extends ComsNetHttpError {
  readonly target: string;
  readonly candidates: string[];

  constructor(status: number, errorCode: string, details: unknown, method: string, url: string, token?: string) {
    const d = details as { target?: string; candidates?: string[] } | undefined;
    const target = d?.target ?? "unknown";
    const candidates = d?.candidates ?? [];
    super(
      status,
      errorCode,
      details,
      method,
      url,
      `Ambiguous target "${target}" matches multiple sessions: [${candidates.join(", ")}]`,
      token
    );
    this.name = "AmbiguousTargetError";
    this.target = target;
    this.candidates = candidates;
  }
}

/** 409 Conflict: Message hop limit reached (hops >= 5) */
export class HopLimitExceededError extends ComsNetHttpError {
  readonly hops: number;
  readonly maxHops: number;

  constructor(status: number, errorCode: string, details: unknown, method: string, url: string, token?: string) {
    const d = details as { hops?: number; max_hops?: number } | undefined;
    const hops = d?.hops ?? 5;
    const maxHops = d?.max_hops ?? 5;
    super(status, errorCode, details, method, url, `Hop limit exceeded: ${hops} >= ${maxHops}`, token);
    this.name = "HopLimitExceededError";
    this.hops = hops;
    this.maxHops = maxHops;
  }
}

/** 409 Conflict: Response submitted for a message already in terminal state */
export class AlreadyTerminalError extends ComsNetHttpError {
  readonly terminalStatus: string;

  constructor(status: number, errorCode: string, details: unknown, method: string, url: string, token?: string) {
    const terminalStatus = (details as { status?: string } | undefined)?.status ?? "complete";
    super(status, errorCode, details, method, url, `Message is already terminal with status "${terminalStatus}"`, token);
    this.name = "AlreadyTerminalError";
    this.terminalStatus = terminalStatus;
  }
}

/** 429 Too Many Requests: Target agent queue depth >= MAX_INBOX (100) */
export class InboxFullError extends ComsNetHttpError {
  readonly depth: number;
  readonly maxInbox: number;

  constructor(status: number, errorCode: string, details: unknown, method: string, url: string, token?: string) {
    const d = details as { depth?: number; max_inbox?: number } | undefined;
    const depth = d?.depth ?? 100;
    const maxInbox = d?.max_inbox ?? 100;
    super(status, errorCode, details, method, url, `Target inbox full: ${depth} >= ${maxInbox} messages pending`, token);
    this.name = "InboxFullError";
    this.depth = depth;
    this.maxInbox = maxInbox;
  }
}

/** 400 Bad Request: Invalid JSON, missing parameters, or bad syntax */
export class BadRequestError extends ComsNetHttpError {
  constructor(status: number, errorCode: string, details: unknown, method: string, url: string, token?: string) {
    super(status, errorCode, details, method, url, `Bad request: ${errorCode}`, token);
    this.name = "BadRequestError";
  }
}

/** Factory to parse HTTP error bodies and instantiate corresponding error subclass */
export function parseHttpError(
  status: number,
  body: unknown,
  method: string,
  url: string,
  token?: string
): ComsNetHttpError {
  const errorObj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const errorCode = typeof errorObj.error === "string" ? errorObj.error : `http_${status}`;
  const details = errorObj.details;

  switch (errorCode) {
    case "unauthorized":
      return new UnauthorizedError(status, errorCode, details, method, url, token);
    case "not_target":
      return new NotTargetError(status, errorCode, details, method, url, token);
    case "target_not_found":
      return new TargetNotFoundError(status, errorCode, details, method, url, token);
    case "agent_not_found":
      return new AgentNotFoundError(status, errorCode, details, method, url, token);
    case "sender_not_registered":
      return new SenderNotRegisteredError(status, errorCode, details, method, url, token);
    case "message_not_found":
      return new MessageNotFoundError(status, errorCode, details, method, url, undefined, token);
    case "ambiguous_target":
      return new AmbiguousTargetError(status, errorCode, details, method, url, token);
    case "hop_limit_exceeded":
      return new HopLimitExceededError(status, errorCode, details, method, url, token);
    case "already_terminal":
      return new AlreadyTerminalError(status, errorCode, details, method, url, token);
    case "inbox_full":
      return new InboxFullError(status, errorCode, details, method, url, token);
    default:
      if (status === 401) return new UnauthorizedError(status, "unauthorized", details, method, url, token);
      if (status === 403) return new NotTargetError(status, errorCode, details, method, url, token);
      if (status === 404) return new TargetNotFoundError(status, errorCode, details, method, url, token);
      if (status === 409) return new ComsNetHttpError(status, errorCode, details, method, url, undefined, token);
      if (status === 429) return new InboxFullError(status, "inbox_full", details, method, url, token);
      if (status === 400) return new BadRequestError(status, errorCode, details, method, url, token);
      return new ComsNetHttpError(status, errorCode, details, method, url, undefined, token);
  }
}
