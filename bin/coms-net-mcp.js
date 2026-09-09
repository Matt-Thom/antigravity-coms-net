#!/usr/bin/env node

/**
 * bin/coms-net-mcp.js
 *
 * Executable wrapper for the coms-net stdio MCP server.
 * Dispatches to compiled dist/mcp/server.js when present, or src/mcp/server.ts via
 * native Node.js type stripping when running in development.
 *
 * CRITICAL ARCHITECTURAL CONSTRAINT:
 * stdout is strictly reserved for Model Context Protocol (MCP) JSON-RPC 2.0 frames.
 * Any diagnostic, warning, or error messages MUST be written to stderr.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distFile = join(__dirname, "..", "dist", "mcp", "server.js");
const srcFile = join(__dirname, "..", "src", "mcp", "server.ts");

if (existsSync(distFile)) {
  const mcp = await import(distFile);
  if (typeof mcp.runMcpServer === "function") {
    await mcp.runMcpServer();
  }
} else if (existsSync(srcFile)) {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", srcFile, ...process.argv.slice(2)],
    { stdio: ["inherit", "inherit", "inherit"] }
  );

  const forwardSignal = (sig) => {
    if (child.pid) child.kill(sig);
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
} else {
  process.stderr.write("Error: Could not locate MCP server at dist/mcp/server.js or src/mcp/server.ts.\n");
  process.stderr.write("Run 'npm run build' first.\n");
  process.exit(1);
}
