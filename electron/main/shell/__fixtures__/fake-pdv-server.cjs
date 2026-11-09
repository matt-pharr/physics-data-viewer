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
 * - FAKE_MODE=no-hello — never write to stdout (hello timeout path). Stays
 *   alive deliberately: the supervisor must kill it rather than orphan it.
 * - FAKE_MODE=crash-after-hello — exit(7) shortly after hello.
 * - FAKE_MODE=ignore-shutdown   — never answer shutdown, swallow SIGTERM
 *   (forces the SIGTERM → SIGKILL escalation).
 * - FAKE_MODE=confirm  — hello, then push a reverse-RPC confirmRequest and
 *   record the shell's confirmResponse (readable via the "lastConfirm"
 *   channel) so the supervisor's dialog glue can be asserted end to end.
 *
 * Every mode prints `fixture pid <pid>` on stderr so tests can assert
 * whether the process was reaped.
 *
 * Channels: pdv.rpc.ping, pdv.rpc.shutdown, "echo" (returns args[0]),
 * "boom" (rejects with message "kaboom"), "never" (no response),
 * "lastConfirm" (returns the recorded confirmResponse payload or null),
 * "whoami" (returns {pid, version} — lets a test tell two fixtures apart),
 * "emitPush" (pushes {event: args[0], payload: args[1]} on demand, so a
 * test can assert which server a push came from).
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
console.error("fixture pid " + process.pid);

let lastConfirm = null;

if (mode === "confirm") {
  send({
    event: "pdv.rpc.confirmRequest",
    payload: {
      requestId: "c1",
      options: {
        type: "question",
        message: "Overwrite?",
        buttons: ["Overwrite", "Cancel"],
        defaultId: 0,
        cancelId: 1,
      },
    },
    seq: seq++,
  });
}

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
    case "pdv.rpc.confirmResponse":
      lastConfirm = msg.args[0];
      send({ id: msg.id });
      return;
    case "lastConfirm":
      send({ id: msg.id, result: lastConfirm });
      return;
    case "whoami":
      send({
        id: msg.id,
        result: { pid: process.pid, version: process.env.FAKE_VERSION || "0.0.0" },
      });
      return;
    case "emitPush":
      send({ event: msg.args[0], payload: msg.args[1], seq: seq++ });
      send({ id: msg.id });
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
