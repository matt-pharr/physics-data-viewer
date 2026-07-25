#!/usr/bin/env node
/**
 * fake-ssh.cjs — Stand-in for the `ssh` binary in remote-layer tests.
 *
 * Emulates the surface `ssh-mux.ts` actually uses: `-o key=value` flags, the
 * `-O check` / `-O stop` control commands, and `ssh <host> <command>`. In its
 * default exec mode it really runs the command through `/bin/sh` on this
 * machine, so the exit sentinel, banner tolerance and exit-code plumbing are
 * exercised end to end rather than mocked — the only thing missing is the
 * network.
 *
 * Behavior is selected via env vars:
 *
 * - FAKE_SSH_MASTER=alive        — `-O check` succeeds (default).
 * - FAKE_SSH_MASTER=absent       — `-O check` fails the way a missing socket does.
 * - FAKE_SSH_MASTER=unconfigured — `-O check` fails the way a host with no
 *   ControlPath does (what a plain `Host` entry answers).
 * - FAKE_SSH_MASTER=refused      — `-O check` reports a socket nothing listens on.
 *
 * - FAKE_SSH_EXEC=local     — run the command under /bin/sh (default).
 * - FAKE_SSH_EXEC=banner    — like `local`, but print MOTD noise on both
 *   streams first, so sentinel parsing is tested against real pollution.
 * - FAKE_SSH_EXEC=drop      — do not run anything; exit 255 as ssh does when
 *   the connection dies (no sentinel is printed).
 * - FAKE_SSH_EXEC=askpass   — reproduce the macOS no-askpass auth failure.
 * - FAKE_SSH_EXEC=hang      — never exit, for deadline tests.
 * - FAKE_SSH_EXEC=exit255   — run nothing, print nothing, exit 255 *with* a
 *   sentinel claiming the remote command exited 255, i.e. the ambiguous case.
 *
 * - FAKE_SSH_LOG — when set, append one JSON line of argv per invocation, so
 *   tests can assert which flags were passed.
 */

const fs = require("fs");
const { spawn } = require("child_process");

const argv = process.argv.slice(2);

if (process.env.FAKE_SSH_LOG) {
  fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(argv) + "\n");
}

// Parse the subset of ssh's argv grammar this fixture needs.
const options = {};
let controlCommand = null;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "-o") {
    const pair = argv[++i] || "";
    const eq = pair.indexOf("=");
    if (eq > 0) options[pair.slice(0, eq)] = pair.slice(eq + 1);
  } else if (arg === "-O") {
    controlCommand = argv[++i] || "";
  } else if (arg === "-T" || arg === "-t" || arg === "-q") {
    // no-op flags
  } else {
    positional.push(arg);
  }
}

const masterMode = process.env.FAKE_SSH_MASTER || "alive";
const execMode = process.env.FAKE_SSH_EXEC || "local";

function die(message, code) {
  process.stderr.write(message + "\n");
  process.exit(code);
}

// --- control commands (-O check / -O stop) ---------------------------------
if (controlCommand) {
  if (masterMode === "unconfigured") {
    // Mirrors a plain `Host` entry: asking about the *config's* ControlPath
    // says there is none, while asking about a socket PDV nominated says the
    // socket is simply not there yet.
    if (!options.ControlPath) {
      die('No ControlPath specified for "-O" command', 255);
    }
    die(`Control socket connect(${options.ControlPath}): No such file or directory`, 255);
  }
  if (masterMode === "absent") {
    die(
      `Control socket connect(${options.ControlPath || "(none)"}): No such file or directory`,
      255,
    );
  }
  if (masterMode === "refused") {
    die(
      `Control socket connect(${options.ControlPath || "(none)"}): Connection refused`,
      255,
    );
  }
  if (controlCommand === "check") {
    process.stderr.write("Master running (pid=4242)\n");
    process.exit(0);
  }
  if (controlCommand === "stop") {
    process.stderr.write("Exit request sent.\n");
    process.exit(0);
  }
  die(`Invalid multiplex command: ${controlCommand}`, 255);
}

// --- exec channel ----------------------------------------------------------
const command = positional.slice(1).join(" ");

if (execMode === "hang") {
  setInterval(() => {}, 1000);
  return;
}

if (execMode === "drop") {
  die("client_loop: send disconnect: Broken pipe", 255);
}

if (execMode === "askpass") {
  die(
    "ssh_askpass: exec(/usr/X11R6/bin/ssh-askpass): No such file or directory\n" +
      "Permission denied, please try again.",
    255,
  );
}

if (execMode === "exit255") {
  // The genuinely ambiguous case: ssh exits 255 because the *remote command*
  // did, and says so via the sentinel.
  const nonce = /'(pdv[0-9a-f]+)'/.exec(command);
  if (nonce) {
    process.stdout.write(
      JSON.stringify({ pdv: "exit", n: nonce[1], code: 255 }) + "\n",
    );
  }
  process.exit(255);
}

if (execMode === "banner") {
  process.stdout.write("Welcome to the cluster!\n{\"pdv\":\"exit\",\"n\":\"wrong-nonce\",\"code\":0}\n");
  process.stderr.write("Last login: Fri Jul 25 10:00:00 2026 from 10.0.0.1\n");
  process.stderr.write("Lmod is automatically replacing 'intel' with 'gcc'.\n");
}

const child = spawn("/bin/sh", ["-c", command], { stdio: ["ignore", "inherit", "inherit"] });
child.on("close", (code) => process.exit(code === null ? 255 : code));
child.on("error", () => process.exit(255));
