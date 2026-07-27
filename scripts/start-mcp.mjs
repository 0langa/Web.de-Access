#!/usr/bin/env node
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function dependenciesLoad() {
  try {
    // Resolve the manifest, not the package root: @modelcontextprotocol/sdk is
    // ESM-only ("type": "module", no "main", subpath-only "exports"), so
    // require.resolve("@modelcontextprotocol/sdk") can never succeed and would
    // force a reinstall on every single startup.
    require.resolve("@modelcontextprotocol/sdk/package.json");
    // keytar is a native addon; requiring it proves the prebuilt binary exists.
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
    // stdout is the MCP stdio transport. Anything npm prints there corrupts the
    // JSON-RPC stream, so installer output goes to stderr only.
    stdio: ["ignore", "ignore", "inherit"],
    shell: false,
  });
  if (result.status !== 0) {
    console.error(
      "webde-access could not install its dependencies. Run `npm ci --omit=dev` in " +
        pluginRoot +
        " and restart.",
    );
    process.exit(result.status ?? 1);
  }
  if (!dependenciesLoad()) {
    console.error(
      "webde-access dependencies were installed but still cannot be loaded. " +
        "keytar needs its native binary; run `npm rebuild keytar` in " +
        pluginRoot +
        " and restart.",
    );
    process.exit(1);
  }
}

await import("../mcp/server.mjs");
