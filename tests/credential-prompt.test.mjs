import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { promptCredentials } from "../scripts/credential-prompt.mjs";

// A terminal stand-in: what the user types goes to `input`, and everything the
// prompt prints (including readline's echo of typed characters) is recorded.
function fakeTerminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (mode) => {
    input.isRaw = mode;
    return input;
  };
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 80;
  let screen = "";
  output.on("data", (chunk) => {
    screen += chunk.toString();
  });

  return {
    input,
    output,
    screen: () => screen,
    async typeAfter(prompt, keys) {
      for (let attempt = 0; !screen.includes(prompt); attempt += 1) {
        assert.ok(attempt < 1000, `prompt never appeared: ${prompt}`);
        await new Promise((resolve) => setImmediate(resolve));
      }
      input.write(keys);
    },
  };
}

test("the app password typed after the email prompt is not echoed", async () => {
  const terminal = fakeTerminal();
  const answers = promptCredentials({}, terminal);
  await terminal.typeAfter("WEB.DE email: ", "user@example.test\r");
  await terminal.typeAfter("WEB.DE app password: ", "s3cret-app-password\r");

  assert.deepEqual(await answers, { email: "user@example.test", password: "s3cret-app-password" });
  assert.match(terminal.screen(), /user@example\.test/);
  assert.doesNotMatch(terminal.screen(), /s3cret/);
  assert.equal(terminal.input.isRaw, false);
});

test("only the missing part of the login is asked for", async () => {
  const terminal = fakeTerminal();
  const answers = promptCredentials({ email: " user@example.test " }, terminal);
  await terminal.typeAfter("WEB.DE app password: ", "s3cret-app-password\r");

  assert.deepEqual(await answers, { email: "user@example.test", password: "s3cret-app-password" });
  assert.doesNotMatch(terminal.screen(), /WEB\.DE email/);
  assert.doesNotMatch(terminal.screen(), /s3cret/);
});

test("piped answers are read even when both lines arrive at once", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const answers = promptCredentials({}, { input, output });
  input.end("user@example.test\ns3cret-app-password\n");

  assert.deepEqual(await answers, { email: "user@example.test", password: "s3cret-app-password" });
});
