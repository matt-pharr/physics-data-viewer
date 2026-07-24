/**
 * fake-pdv-server.cjs — Child-process fixture for server-supervisor tests.
 *
 * Speaks just enough of the stdio RPC protocol (newline-delimited JSON,
 * hello push, request/response envelopes) for the supervisor to exercise
 * its lifecycle paths against a real spawned process. Behavior is selected
 * via env vars:
 *
 * - FAKE_VERSION       — version advertised in the hello push.
 * - FAKE_MODE=normal   — hello, then answer requests (default).
 * - FAKE_MODE=no-hello — never write anything (hello timeout path).
 * - FAKE_MODE=crash-after-hello — exit(7) shortly after hello.
 * - FAKE_MODE=ignore-shutdown   — never answer shutdown, swallow SIGTERM
 *   (forces the SIGTERM → SIGKILL escalation).
 *
 * Channels: pdv.rpc.ping, pdv.rpc.shutdown, "echo" (returns args[0]),
 * "boom" (rejects with message "kaboom"), "never" (no response).
 */

const readline = require("readline");

const mode = process.env.FAKE_MODE || "normal";
let seq = 0;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

if (mode !== "no-hello") {
  send({
    event: "pdv.rpc.hello",
    payload: {
      version: process.env.FAKE_VERSION || "0.0.0",
      pid: process.pid,
      protocol: 1,
      session: null,
    },
    seq: seq++,
  });
}

console.error("fixture started");

if (mode === "crash-after-hello") {
  setTimeout(() => process.exit(7), 50);
}
if (mode === "ignore-shutdown") {
  process.on("SIGTERM", () => {});
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg.id !== "string") return;
  switch (msg.channel) {
    case "pdv.rpc.ping":
      send({ id: msg.id, result: { ts: 0, seq: seq - 1 } });
      return;
    case "pdv.rpc.shutdown":
      if (mode === "ignore-shutdown") return;
      send({ id: msg.id });
      setTimeout(() => process.exit(0), 10);
      return;
    case "echo":
      send({ id: msg.id, result: msg.args[0] });
      return;
    case "boom":
      send({ id: msg.id, error: { message: "kaboom", name: "Error" } });
      return;
    case "never":
      return;
    default:
      send({ id: msg.id });
  }
});

// Mirror the real server: exit when the shell's stdin pipe closes.
rl.on("close", () => {
  setTimeout(() => process.exit(0), 10);
});
