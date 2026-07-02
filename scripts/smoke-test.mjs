import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { legacySecretNames } from "../mcp/auth-config.mjs";

const profileIndex = process.argv.indexOf("--profile");
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : process.env.WEBDE_ACCESS_PROFILE;
const childEnv = { ...process.env };
for (const name of legacySecretNames) {
  delete childEnv[name];
}
if (profile) {
  childEnv.WEBDE_ACCESS_PROFILE = profile;
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["./mcp/server.mjs"],
  cwd: process.cwd(),
  env: childEnv,
});

const client = new Client({ name: "webde-access-smoke-test", version: "0.1.0" });

await client.connect(transport);

try {
  const tools = await client.listTools();
  const check = await client.callTool({ name: "check_webde_connection", arguments: {} });
  const quota = await client.callTool({ name: "get_webde_quota", arguments: {} });
  const search = await client.callTool({
    name: "search_webde_messages",
    arguments: { mailbox: "INBOX", limit: 1 },
  });

  const first = search.structuredContent?.messages?.[0] || null;
  let read = null;
  if (first?.uid) {
    read = await client.callTool({
      name: "read_webde_message",
      arguments: { mailbox: "INBOX", uid: first.uid, includeHtml: false },
    });
  }

  console.log(
    JSON.stringify(
      {
        toolCount: tools.tools.length,
        tools: tools.tools.map((tool) => tool.name),
        checkOk: !check.isError,
        quotaOk: !quota.isError,
        searchOk: !search.isError,
        readOk: read ? !read.isError : null,
        profile: profile || "default",
        firstUid: first?.uid || null,
        firstAttachmentParts: first?.attachments || [],
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
