/**
 * src/protocol/discovery.ts
 *
 * coms-net Hub Discovery and Configuration Resolver
 *
 * Implements:
 * 1. Filesystem discovery: ~/.pi/coms-net/projects/<project>/server.json and server.secret.json
 * 2. Security enforcement: POSIX mode 0600 check (st.mode & 0o777 === 0o600) on secret file
 * 3. Symlink rejection to prevent privilege escalation / race conditions
 * 4. Path traversal protection on project names (^[a-zA-Z0-9_-]+$)
 * 5. Precedence hierarchy: CLI flags / options > Environment variables > Filesystem
 * 6. Token redaction & safe diagnostics
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  HubConfig,
  DiscoveryOptions,
  DiscoveryResult,
  DiscoverySource,
  ServerJson,
  ServerSecretJson,
} from "./types.ts";
import {
  NoServerUrlError,
  NoAuthTokenError,
  InvalidProjectNameError,
  HubDiscoveryError,
  redactToken,
} from "./errors.ts";

// ── Constants & Environment Variable Names ──────────────────────────────────

export const DEFAULT_PROJECT = "default";
export const ENV_SERVER_URL = "PI_COMS_NET_SERVER_URL";
export const ENV_AUTH_TOKEN = "PI_COMS_NET_AUTH_TOKEN";
export const ENV_PROJECT = "PI_COMS_NET_PROJECT";
export const ENV_REGISTRY_DIR = "PI_COMS_NET_DIR";

export function getDefaultRegistryDir(): string {
  return process.env[ENV_REGISTRY_DIR] || path.join(os.homedir(), ".pi", "coms-net");
}

// ── Path & Sanitation Helpers ───────────────────────────────────────────────

const PROJECT_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

export function validateProjectName(project: string): string {
  if (!project || !PROJECT_NAME_REGEX.test(project)) {
    throw new InvalidProjectNameError(project);
  }
  return project;
}

export function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

export function getProjectDir(project: string, registryDir?: string): string {
  const root = registryDir || getDefaultRegistryDir();
  const validProject = validateProjectName(project);
  return path.join(root, "projects", validProject);
}

// ── File Parsers & Security Enforcement ─────────────────────────────────────

export function readServerJson(projectDir: string): ServerJson | null {
  const filePath = path.join(projectDir, "server.json");
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as ServerJson;
    if (!parsed || typeof parsed.local_url !== "string" || parsed.local_url.trim().length === 0) {
      return null;
    }
    // Validate URL format
    new URL(parsed.local_url);
    return {
      ...parsed,
      local_url: stripTrailingSlashes(parsed.local_url.trim()),
      public_url: parsed.public_url ? stripTrailingSlashes(parsed.public_url.trim()) : undefined,
    };
  } catch {
    return null;
  }
}

export interface SecretReadResult {
  secret: ServerSecretJson | null;
  rejectionReason?: string;
}

/**
 * Reads server.secret.json with strict POSIX mode 0600 verification.
 * Only mode 0600 is trusted. Symlinks and looser permissions are rejected.
 */
export function readServerSecret(projectDir: string): SecretReadResult {
  const filePath = path.join(projectDir, "server.secret.json");
  try {
    if (!fs.existsSync(filePath)) {
      return { secret: null, rejectionReason: "file_not_found" };
    }

    // Guard against symlink attacks
    const lst = fs.lstatSync(filePath);
    if (lst.isSymbolicLink()) {
      return { secret: null, rejectionReason: "symlink_not_allowed" };
    }

    // POSIX Mode Check: Must be strictly 0600 (read/write by owner only)
    const st = fs.statSync(filePath);
    const mode = st.mode & 0o777;
    if (mode !== 0o600) {
      return {
        secret: null,
        rejectionReason: `insecure_permissions_0o${mode.toString(8)}_expected_0o600`,
      };
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as ServerSecretJson;
    if (!parsed || typeof parsed.token !== "string" || parsed.token.trim().length === 0) {
      return { secret: null, rejectionReason: "invalid_secret_json_format" };
    }

    return { secret: { token: parsed.token.trim() } };
  } catch (err: unknown) {
    return {
      secret: null,
      rejectionReason: `read_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function safeHubConfig(config: HubConfig): HubConfig {
  return {
    ...config,
    authToken: "<redacted>",
  };
}

// ── Resolution Logic ────────────────────────────────────────────────────────

/**
 * Synchronous resolution of coms-net hub connection parameters.
 */
export function discoverHubSync(options: DiscoveryOptions = {}): DiscoveryResult {
  const diagnostics: string[] = [];

  // 1. Resolve Project Namespace
  let project = DEFAULT_PROJECT;
  let projectSource: "option" | "env" | "default" = "default";
  if (options.project && options.project.trim().length > 0) {
    project = validateProjectName(options.project.trim());
    projectSource = "option";
  } else if (process.env[ENV_PROJECT] && process.env[ENV_PROJECT]!.trim().length > 0) {
    project = validateProjectName(process.env[ENV_PROJECT]!.trim());
    projectSource = "env";
  }

  const projectDirectory = getProjectDir(project, options.registryDir);
  const serverJsonPath = path.join(projectDirectory, "server.json");
  const secretJsonPath = path.join(projectDirectory, "server.secret.json");

  // Load server.json if available
  const serverInfo = readServerJson(projectDirectory);

  // 2. Resolve Server URL
  let baseUrl: string | null = null;
  let urlSource: "option" | "env" | "file" = "file";

  if (options.serverUrl && options.serverUrl.trim().length > 0) {
    baseUrl = stripTrailingSlashes(options.serverUrl.trim());
    urlSource = "option";
  } else if (process.env[ENV_SERVER_URL] && process.env[ENV_SERVER_URL]!.trim().length > 0) {
    baseUrl = stripTrailingSlashes(process.env[ENV_SERVER_URL]!.trim());
    urlSource = "env";
  } else if (serverInfo && serverInfo.local_url) {
    baseUrl = serverInfo.local_url;
    urlSource = "file";
  }

  if (!baseUrl) {
    throw new NoServerUrlError(project, serverJsonPath);
  }

  // Validate URL format
  try {
    const parsedUrl = new URL(baseUrl);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(`Invalid protocol '${parsedUrl.protocol}' (must be http: or https:)`);
    }
  } catch (err: unknown) {
    throw new HubDiscoveryError(
      `coms-net: resolved invalid server URL '${baseUrl}': ${err instanceof Error ? err.message : String(err)}`,
      "INVALID_SERVER_URL"
    );
  }

  // 3. Resolve Auth Token
  let authToken: string | null = null;
  let tokenSource: "option" | "env" | "secret_file" = "secret_file";

  if (options.authToken && options.authToken.trim().length > 0) {
    authToken = options.authToken.trim();
    tokenSource = "option";
  } else if (process.env[ENV_AUTH_TOKEN] && process.env[ENV_AUTH_TOKEN]!.trim().length > 0) {
    authToken = process.env[ENV_AUTH_TOKEN]!.trim();
    tokenSource = "env";
  } else {
    const { secret, rejectionReason } = readServerSecret(projectDirectory);
    if (secret) {
      authToken = secret.token;
      tokenSource = "secret_file";
    } else {
      if (rejectionReason && rejectionReason !== "file_not_found") {
        diagnostics.push(`Rejected secret file ${secretJsonPath}: ${rejectionReason}`);
      }
      throw new NoAuthTokenError(project, secretJsonPath, rejectionReason);
    }
  }

  const source: DiscoverySource = {
    urlSource,
    tokenSource,
    projectSource,
    serverJsonPath,
    secretJsonPath,
    diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
  };

  return {
    config: {
      baseUrl,
      authToken,
      project,
    },
    source,
    serverInfo: serverInfo ?? undefined,
  };
}

/**
 * Asynchronous resolution of coms-net hub connection parameters.
 */
export async function discoverHub(options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  return discoverHubSync(options);
}
