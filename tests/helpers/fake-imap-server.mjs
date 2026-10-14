import net from "node:net";

// A scripted IMAP server for offline tests. It speaks just enough RFC 3501 for
// ImapFlow to log in over plain TCP on 127.0.0.1, list folders and open a
// mailbox. Every other command goes to the test's `onCommand` handler. It
// stores no mail and never contacts a real server.
//
// `mailboxes` is what LIST reports, one [path, ...attributes] entry per folder
// with the path in its wire form (modified UTF-7). A server with SPECIAL-USE
// (RFC 6154) lists its Sent folder as ["Sent", "\\HasNoChildren", "\\Sent"].
export async function startFakeImapServer({
  capabilities = "IMAP4rev1 UIDPLUS",
  mailboxes = [["INBOX", "\\HasNoChildren"]],
  onCommand,
} = {}) {
  const commands = [];
  const sockets = new Set();

  const defaults = {
    CAPABILITY: ({ tag, write }) => write(`* CAPABILITY ${capabilities}\r\n${tag} OK CAPABILITY completed\r\n`),
    LOGIN: ({ tag, write }) => write(`${tag} OK [CAPABILITY ${capabilities}] LOGIN completed\r\n`),
    LIST: ({ tag, args, write }) => {
      const pattern = listPattern(args);
      let listing = "";
      if (pattern === "") {
        listing = '* LIST (\\Noselect) "/" ""\r\n';
      } else {
        for (const [path, ...attributes] of mailboxes) {
          if (matchesListPattern(path, pattern)) {
            listing += `* LIST (${attributes.join(" ")}) "/" "${path}"\r\n`;
          }
        }
      }
      write(`${listing}${tag} OK LIST completed\r\n`);
    },
    SELECT: ({ tag, write }) => write(`${selectedState()}${tag} OK [READ-WRITE] SELECT completed\r\n`),
    EXAMINE: ({ tag, write }) => write(`${selectedState()}${tag} OK [READ-ONLY] EXAMINE completed\r\n`),
    CLOSE: ({ tag, write }) => write(`${tag} OK CLOSE completed\r\n`),
    NOOP: ({ tag, write }) => write(`${tag} OK NOOP completed\r\n`),
    LOGOUT: ({ tag, write, socket }) => {
      write(`* BYE fake IMAP closing\r\n${tag} OK LOGOUT completed\r\n`);
      socket.end();
    },
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const write = (data) => {
      if (!socket.destroyed) {
        socket.write(data);
      }
    };

    let buffer = Buffer.alloc(0);
    let line = "";
    let literals = [];
    let literalBytes = 0;

    const dispatch = async (text, commandLiterals) => {
      const [tag, name = "", ...rest] = text.split(" ");
      let command = name.toUpperCase();
      let args = rest.join(" ");
      if (command === "UID") {
        command = `UID ${(rest[0] || "").toUpperCase()}`;
        args = rest.slice(1).join(" ");
      }
      const entry = { tag, command, args, literals: commandLiterals };
      commands.push(entry);
      const context = { ...entry, write, socket };
      if (onCommand && (await onCommand(context))) {
        return;
      }
      if (defaults[command]) {
        defaults[command](context);
      } else {
        write(`${tag} BAD fake server does not implement ${command}\r\n`);
      }
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (literalBytes) {
          if (buffer.length < literalBytes) {
            return;
          }
          literals.push(buffer.subarray(0, literalBytes));
          buffer = buffer.subarray(literalBytes);
          literalBytes = 0;
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) {
          return;
        }
        const part = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 2);
        const literal = /\{(\d+)(\+?)\}$/.exec(part);
        if (literal) {
          line += part.slice(0, literal.index);
          literalBytes = Number(literal[1]);
          if (!literal[2]) {
            write("+ go ahead\r\n");
          }
          if (literalBytes) {
            continue;
          }
          literals.push(Buffer.alloc(0));
          continue;
        }
        const text = line + part;
        const commandLiterals = literals;
        line = "";
        literals = [];
        dispatch(text, commandLiterals).catch(() => socket.destroy());
      }
    });

    write("* OK fake IMAP ready\r\n");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    port: server.address().port,
    commands,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// LIST [(selection options)] reference pattern [RETURN (return options)]
function listPattern(args) {
  const tokens = [...args.matchAll(/\([^)]*\)|"((?:[^"\\]|\\.)*)"|[^\s()]+/g)];
  const pattern = (tokens[0]?.[0].startsWith("(") ? tokens.slice(1) : tokens)[1];
  if (!pattern) {
    return "";
  }
  return pattern[1] === undefined ? pattern[0] : pattern[1].replace(/\\(.)/g, "$1");
}

// "*" also matches across the "/" delimiter, "%" only within one level.
// INBOX matches in any case.
function matchesListPattern(path, pattern) {
  const source = [...pattern]
    .map((char) => (char === "*" ? ".*" : char === "%" ? "[^/]*" : char.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`, path.toUpperCase() === "INBOX" ? "i" : "").test(path);
}

function selectedState() {
  return (
    "* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n" +
    "* 1 EXISTS\r\n" +
    "* 0 RECENT\r\n" +
    "* OK [UIDVALIDITY 1] UIDs valid\r\n" +
    "* OK [UIDNEXT 100] Predicted next UID\r\n"
  );
}

// Profile shape returned by loadRuntimeConfig(), pointed at a fake server.
export function fakeConfig(overrides = {}) {
  return {
    profile: "test",
    email: "user@example.test",
    password: "not-a-real-password",
    defaultFromName: "",
    folders: {
      inbox: "INBOX",
      sent: "Gesendet",
      drafts: "Entwurf",
      outbox: "Postausgang",
      trash: "Papierkorb",
      spam: "Spam",
      junk: "Junk-E-Mail",
      important: "wichtig",
    },
    attachmentDownloadDir: "",
    allowedAttachmentRoots: [],
    saveSentCopy: true,
    markReadOnFetch: false,
    maxFetchMessages: 50,
    maxAttachmentBytes: 1024 * 1024,
    maxSourceBytes: 1024 * 1024,
    imapHost: "127.0.0.1",
    imapPort: 0,
    imapSecure: false,
    smtpHost: "127.0.0.1",
    smtpPort: 0,
    smtpSecure: false,
    ...overrides,
  };
}

// Answers a UID FETCH with the requested items for one message. `sections`
// maps an IMAP section ("" for the full message, "2", "2.MIME") to its bytes;
// partial requests such as BODY.PEEK[2]<65536.65536> are sliced accordingly.
export function fetchReply({ tag, args, uid, size, sections = {}, envelope, write }) {
  const items = [`UID ${uid}`];
  if (/RFC822\.SIZE/.test(args)) {
    items.push(`RFC822.SIZE ${size}`);
  }
  if (/\bFLAGS\b/.test(args)) {
    items.push("FLAGS ()");
  }
  if (/\bENVELOPE\b/.test(args) && envelope) {
    items.push(`ENVELOPE ${envelope}`);
  }
  const chunks = [];
  for (const match of args.matchAll(/BODY\.PEEK\[([^\]]*)\](?:<(\d+)\.(\d+)>)?/g)) {
    const section = match[1].toUpperCase();
    const data = sections[section];
    if (!data) {
      continue;
    }
    const start = match[2] ? Number(match[2]) : 0;
    const slice = match[3] ? data.subarray(start, start + Number(match[3])) : data;
    chunks.push([`BODY[${match[1]}]${match[2] ? `<${start}>` : ""}`, slice]);
  }

  const parts = [Buffer.from(`* 1 FETCH (${items.join(" ")}`)];
  for (const [name, data] of chunks) {
    parts.push(Buffer.from(` ${name} {${data.length}}\r\n`), data);
  }
  parts.push(Buffer.from(`)\r\n${tag} OK FETCH completed\r\n`));
  write(Buffer.concat(parts));
}
