import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Kimi manifest pins the dev profile and contains no secrets", () => {
  const manifest = JSON.parse(fs.readFileSync("kimi.plugin.json", "utf8"));
  assert.equal(manifest.mcpServers["webde-access"].env.WEBDE_ACCESS_PROFILE, "dev");
  assert.doesNotMatch(JSON.stringify(manifest), /WEBDE_(?:APP_)?PASSWORD/);
});

test("Claude and Codex manifests contain no WEB.DE credentials", () => {
  const claude = fs.readFileSync(".claude-plugin/plugin.json", "utf8");
  const codex = fs.readFileSync(".codex-plugin/plugin.json", "utf8");
  assert.doesNotMatch(claude, /WEBDE_(?:APP_)?PASSWORD/);
  assert.doesNotMatch(codex, /WEBDE_(?:APP_)?PASSWORD/);
});

test("Codex MCP entrypoint bootstraps OS-native dependencies", () => {
  const mcp = JSON.parse(fs.readFileSync(".mcp.json", "utf8"));
  assert.equal(mcp.mcpServers["webde-access"].command, "node");
  assert.deepEqual(mcp.mcpServers["webde-access"].args, ["./scripts/start-mcp.mjs"]);
  assert.ok(fs.existsSync("scripts/start-mcp.mjs"));
});
