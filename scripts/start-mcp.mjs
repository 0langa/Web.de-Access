#!/usr/bin/env node
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function dependenciesLoad() {
  try {
    require.resolve("@modelcontextprotocol/sdk");
    require("keytar");
    return true;
  } catch {
    return false;
  }
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

if (!dependenciesLoad()) {
  const result = spawnSync(npmCommand(), ["ci", "--omit=dev"], {
    cwd: pluginRoot,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  if (!dependenciesLoad()) {
    console.error("webde-access dependencies were installed but still cannot be loaded.");
    process.exit(1);
  }
}

await import("../mcp/server.mjs");
