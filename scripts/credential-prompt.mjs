import readline from "node:readline/promises";
import { StringDecoder } from "node:string_decoder";

// Asks for whatever part of the WEB.DE login was not passed on the command line.
export async function promptCredentials({ email, password } = {}, { input = process.stdin, output = process.stdout } = {}) {
  let address = typeof email === "string" ? email.trim() : "";
  let secret = typeof password === "string" ? password : "";
  if (address && secret) {
    return { email: address, password: secret };
  }

  if (!input.isTTY) {
    // Piped input: one line iterator for both answers, so a password line that
    // arrives in the same chunk as the email is kept instead of being dropped.
    const rl = readline.createInterface({ input, terminal: false });
    const lines = rl[Symbol.asyncIterator]();
    const nextLine = async (prompt) => {
      output.write(prompt);
      const { value, done } = await lines.next();
      return done ? "" : value;
    };
    try {
      address ||= (await nextLine("WEB.DE email: ")).trim();
      secret ||= await nextLine("WEB.DE app password: ");
    } finally {
      rl.close();
    }
    return { email: address, password: secret };
  }

  if (!address) {
    // The line editor must be closed before the password prompt starts: an
    // open readline interface echoes every keystroke, the password included.
    const rl = readline.createInterface({ input, output });
    try {
      address = (await rl.question("WEB.DE email: ")).trim();
    } finally {
      rl.close();
    }
  }
  secret ||= await readHidden("WEB.DE app password: ", { input, output });
  return { email: address, password: secret };
}

function readHidden(prompt, { input, output }) {
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw;
    // Keeps a multi-byte character that is split across two reads intact.
    const decoder = new StringDecoder("utf8");

    function cleanup() {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
    }

    function onData(buffer) {
      const text = typeof buffer === "string" ? buffer : decoder.write(buffer);
      for (const char of text) {
        if (char === "\u0003") {
          cleanup();
          reject(new Error("Interrupted."));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (char === "\b" || char === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    }

    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}
