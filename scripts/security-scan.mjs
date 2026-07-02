#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const findings = [];

const ignoredDirs = new Set([".git", "node_modules"]);
const secretNamePattern = /\b(WEBDE_PASSWORD|WEBDE_APP_PASSWORD)\b/;
const envFilePattern = /^\.env(?:\.|$)/;

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        walk(fullPath);
      }
      continue;
    }

    if (envFilePattern.test(entry.name) && entry.name !== ".env.example") {
      findings.push(`Legacy env file present: ${path.relative(repoRoot, fullPath)}`);
      continue;
    }

    if (!/\.(mjs|js|json|md|txt|example|yml|yaml|gitignore)$/i.test(entry.name)) {
      continue;
    }

    const content = fs.readFileSync(fullPath, "utf8");
    if (secretNamePattern.test(content) && !fullPath.endsWith(path.join("scripts", "security-scan.mjs"))) {
      const allowed =
        fullPath.endsWith(path.join("mcp", "auth-config.mjs")) ||
        fullPath.endsWith(path.join("scripts", "webde-auth.mjs")) ||
        fullPath.endsWith(path.join("tests", "auth-config.test.mjs")) ||
        fullPath.endsWith("README.md") ||
        fullPath.endsWith(path.join("skills", "webde-access", "SKILL.md")) ||
        fullPath.endsWith(path.join("claude-code", "skills", "webde-access", "SKILL.md")) ||
        fullPath.endsWith(path.join("skills", "webde-access", "references", "configuration.md"));
      if (!allowed) {
        findings.push(`Secret env variable reference outside auth/docs: ${path.relative(repoRoot, fullPath)}`);
      }
    }
  }
}

walk(repoRoot);

if (findings.length) {
  console.error(findings.join("\n"));
  process.exitCode = 1;
} else {
  console.log("WEB.DE security scan passed: no legacy env files or unexpected secret references found.");
}
