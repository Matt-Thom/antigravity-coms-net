#!/usr/bin/env node

/**
 * bin/coms-net-bridge.js
 *
 * Executable wrapper for the coms-net-bridge daemon CLI.
 * Dispatches to compiled dist/cli.js when present, or src/cli.ts via
 * native Node.js type stripping when running in development.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distFile = join(__dirname, "..", "dist", "cli.js");
const srcFile = join(__dirname, "..", "src", "cli.ts");

if (existsSync(distFile)) {
  const cli = await import(distFile);
  if (typeof cli.main === "function") {
    await cli.main();
  }
} else if (existsSync(srcFile)) {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", srcFile, ...process.argv.slice(2)],
    { stdio: "inherit" }
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
  console.error("Error: Could not locate entrypoint at dist/cli.js or src/cli.ts.");
  console.error("Run 'npm run build' first.");
  process.exit(1);
}
