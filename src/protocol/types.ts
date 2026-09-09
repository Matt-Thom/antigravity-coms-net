/**
 * src/protocol/types.ts
 *
 * Authoritative TypeScript protocol types for coms-net v1.
 * Shared across discovery, REST client, tools, bridge lifecycle, SSE, and MCP.
 */

// ── Literal Unions ──────────────────────────────────────────────────────────

export type AgentStatus = "online" | "stale" | "offline";
export type MessageStatus = "queued" | "delivered" | "complete" | "error" | "timeout";
export type DisconnectReason = "shutdown" | "stale" | "connection_closed";

// ── Hub Discovery & Configuration ───────────────────────────────────────────

export interface ServerJson {
  version: number;
  project: string;
  pid?: number;
  host?: string;
  port?: number;
  local_url: string;
  public_url?: string;
  started_at?: string;
  server_id?: string;
}

export interface ServerSecretJson {
  token: string;
}

export interface HubConfig {
  baseUrl: string;
  authToken: string;
  project: string;
}

export interface DiscoveryOptions {
  serverUrl?: string;
  authToken?: string;
  project?: string;
  registryDir?: string;
}

export interface DiscoverySource {
  urlSource: "option" | "env" | "file";
  tokenSource: "option" | "env" | "secret_file";
  projectSource: "option" | "env" | "default";
  serverJsonPath?: string;
  secretJsonPath?: string;
  diagnostics?: string[];
}

export interface DiscoveryResult {
  config: HubConfig;
  source: DiscoverySource;
  serverInfo?: ServerJson;
}

// ── Agent Metadata & Presence ───────────────────────────────────────────────

export interface AgentCard {
  session_id: string;        // 26-char Crockford Base32 ULID
  name: string;              // Resolved unique name within project
  purpose: string;           // Concise description of role / capabilities
  model: string;             // Active LLM model ID
  provider?: string;         // Optional LLM provider
  color: string;             // Hex color code (e.g., "#36F9F6")
  cwd: string;               // Working directory of the agent
  project: string;           // Project namespace
  explicit: boolean;         // True if hidden from standard peer discovery
  started_at: string;        // ISO 8601 startup timestamp
  context_used_pct: number;  // Current context window usage (0-100)
  queue_depth: number;       // Pending inbound prompt queue depth
  status: AgentStatus;       // "online" | "stale" | "offline"
  last_seen_at?: number;     // Millisecond timestamp of last heartbeat
}

export interface RegistryEntry extends AgentCard {
  last_seen_at: number;      // Millisecond timestamp of last heartbeat
  registered_at: string;     // ISO 8601 registration timestamp
}

// ── REST API Request & Response Types ────────────────────────────────────────

export interface HealthResponse {
  ok: true;
  version: number;
  server_id: string;
  started_at: string;
}

export interface RegisterRequest {
  project: string;
  session_id: string;
  name: string;
  purpose?: string;
  model?: string;
  provider?: string;
  color?: string;
  cwd?: string;
  explicit?: boolean;
}

export interface RegisterResponse {
  ok: true;
  agent: AgentCard;
  heartbeat_interval_ms: number;
  sse_url: string;
}

export interface HeartbeatRequest {
  project?: string;
  context_used_pct?: number;
  queue_depth?: number;
  model?: string;
  status?: AgentStatus;
}

export interface HeartbeatResponse {
  ok: true;
}

export interface ListAgentsParams {
  project?: string;
  include_explicit?: boolean;
}

export interface ListAgentsResponse {
  agents: AgentCard[];
}

export interface SendRequest {
  project?: string;
  sender_session: string;
  target?: string;
  target_session?: string | null;
  prompt: string;
  conversation_id?: string | null;
  response_schema?: Record<string, unknown> | null;
  hops?: number;
}

export interface SendResponse {
  ok: true;
  msg_id: string;
  status: "queued" | "delivered";
  target_session: string;
}

export interface SendMessageParams {
  target: string;
  prompt: string;
  conversation_id?: string;
  response_schema?: Record<string, unknown>;
  hops?: number;
}

export interface SendMessageResult {
  msg_id: string;
  status: "queued" | "delivered";
  target_session: string;
  hops: number;
}

export interface MessageResult {
  status: MessageStatus;
  response: unknown | null;
  error?: string | null;
}

export interface MessageQueryResponse {
  msg_id: string;
  status: MessageStatus;
  response: unknown | null;
  error: string | null;
}

export type GetMessageResponse = MessageQueryResponse;

export interface MessageAwaitParams {
  msg_id: string;
  timeout_ms?: number;
}

export interface AwaitMessageParams {
  timeout_ms?: number;
}

export interface MessageAwaitResponse {
  msg_id: string;
  status: "complete" | "error" | "timeout";
  response: unknown | null;
  error: string | null;
}

export type AwaitMessageResponse = MessageAwaitResponse;

export interface ResponseSubmitRequest {
  project?: string;
  responder_session: string;
  response?: unknown;
  error?: string | null;
}

export interface ResponseSubmitResponse {
  ok: true;
}

export interface DeleteAgentParams {
  project?: string;
}

export interface UnregisterResponse {
  ok: true;
}

export interface ApiErrorResponse {
  ok: false;
  error: string;
  details?: unknown;
}

export interface ConnectivityValidation {
  reachable: boolean;
  authenticated: boolean;
  serverId?: string;
  version?: number;
  startedAt?: string;
  error?: string;
}

// ── SSE Streaming Wire Types ────────────────────────────────────────────────

export interface HelloPayload {
  server_time: string;
  server_id: string;
}

export interface PoolSnapshotPayload {
  project: string;
  agents: AgentCard[];
}

export interface AgentJoinedPayload {
  project: string;
  agent: AgentCard;
}

export interface AgentUpdatedPayload {
  project: string;
  agent: {
    session_id: string;
    name: string;
    context_used_pct?: number;
    queue_depth?: number;
    model?: string;
    status?: AgentStatus;
  };
}

export interface AgentStalePayload {
  project: string;
  session_id: string;
  name: string;
  last_seen_at: string;
}

export interface AgentLeftPayload {
  project: string;
  session_id: string;
  name: string;
  reason: DisconnectReason;
}

export interface InboundPromptPayload {
  msg_id: string;
  project: string;
  sender: {
    session_id: string;
    name: string;
    cwd: string;
  };
  prompt: string;
  conversation_id: string | null;
  response_schema: Record<string, unknown> | null;
  hops: number;
}

export interface ResponsePayload {
  msg_id: string;
  project: string;
  responder: {
    session_id: string;
    name: string;
  };
  response: unknown | null;
  error: string | null;
  status: "complete" | "error";
}

export interface MessageStatusPayload {
  msg_id: string;
  status: MessageStatus;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

export type SseEventName =
  | "hello"
  | "pool_snapshot"
  | "agent_joined"
  | "agent_updated"
  | "agent_stale"
  | "agent_left"
  | "prompt"
  | "response"
  | "message_status"
  | "error";

export interface SseEventMap {
  hello: HelloPayload;
  pool_snapshot: PoolSnapshotPayload;
  agent_joined: AgentJoinedPayload;
  agent_updated: AgentUpdatedPayload;
  agent_stale: AgentStalePayload;
  agent_left: AgentLeftPayload;
  prompt: InboundPromptPayload;
  response: ResponsePayload;
  message_status: MessageStatusPayload;
  error: ErrorPayload;
}

export type ComsNetEvent =
  | { event: "hello"; data: HelloPayload; id?: number }
  | { event: "pool_snapshot"; data: PoolSnapshotPayload; id?: number }
  | { event: "agent_joined"; data: AgentJoinedPayload; id?: number }
  | { event: "agent_updated"; data: AgentUpdatedPayload; id?: number }
  | { event: "agent_stale"; data: AgentStalePayload; id?: number }
  | { event: "agent_left"; data: AgentLeftPayload; id?: number }
  | { event: "prompt"; data: InboundPromptPayload; id?: number }
  | { event: "response"; data: ResponsePayload; id?: number }
  | { event: "message_status"; data: MessageStatusPayload; id?: number }
  | { event: "error"; data: ErrorPayload; id?: number };

export interface InboundContext {
  msg_id: string;
  hops: number;
  sender_session: string;
  sender_name: string;
  sender_cwd: string;
  prompt: string;
  conversation_id?: string | null;
  response_schema?: Record<string, unknown> | null;
  fulfilled: boolean;
}

// ── Inbound Prompt Event & Turn Execution (PROJECT.md contract) ─────────────

export interface InboundPromptEvent {
  msg_id: string;
  sender_session: string;
  sender_name: string;
  sender_project: string;
  prompt: string;
  conversation_id?: string;
  response_schema?: Record<string, unknown>;
  hops: number;
}

export interface TurnExecutionResult {
  response: string;
  error?: string;
}

export interface ITurnExecutor {
  execute(event: InboundPromptEvent): Promise<TurnExecutionResult>;
}

// ── Client Tool Types (coms_net_* MCP / CLI tools) ──────────────────────────

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolResult<TDetails = Record<string, unknown>> {
  content: ToolTextContent[];
  details?: TDetails;
  isError?: boolean;
}

export interface ToolListParams {
  project?: string;
  include_explicit?: boolean;
}

export interface ToolListResult {
  content: ToolTextContent[];
  details: {
    project: string;
    agents: AgentCard[];
  };
}

export interface ToolSendParams {
  target: string;
  prompt: string;
  conversation_id?: string;
  response_schema?: Record<string, unknown>;
}

export interface ToolSendResult {
  content: ToolTextContent[];
  details: {
    msg_id: string;
    target: string;
    target_session: string;
    hops: number;
    status: string;
  };
}

export interface ToolGetParams {
  msg_id: string;
}

export interface ToolGetResult {
  content: ToolTextContent[];
  details: {
    status: MessageStatus;
    response?: unknown;
    error?: string | null;
  };
  isError?: boolean;
}

export interface ToolAwaitParams {
  msg_id: string;
  timeout_ms?: number;
}

export interface ToolAwaitResult {
  content: ToolTextContent[];
  details: {
    status: "complete" | "error" | "timeout";
    response?: unknown;
    error?: string | null;
  };
  isError?: boolean;
}
