#!/usr/bin/env node
/**
 * fake-ssh.cjs — Stand-in for the `ssh` binary in remote-layer tests.
 *
 * Emulates the surface `ssh-mux.ts` and `ssh-pty.ts` actually use: `-o
 * key=value` flags, the `-O check` / `-O stop` control commands, master
 * establishment (`-N -M`), and `ssh <host> <command>`. In its default exec
 * mode it really runs the command through `/bin/sh` on this machine, and in
 * its prompting auth modes it really reads from the terminal, so the exit
 * sentinel, banner tolerance, exit-code plumbing and pty round trip are all
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
 * - FAKE_SSH_MASTER=stateful     — the honest one: `-O check` answers "alive"
 *   only once a master is actually holding the socket, so the absent→alive
 *   transition PDV polls for really happens. A check with no ControlPath
 *   still answers like a plain `Host` entry.
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
 * Master establishment (`-N`) is selected by FAKE_SSH_AUTH:
 *
 * - FAKE_SSH_AUTH=hold    — authenticate silently and stay running, as a real
 *   foreground master does (default).
 * - FAKE_SSH_AUTH=ok      — authenticate then exit 0 immediately: a master
 *   that never materialised, which must not count as success.
 * - FAKE_SSH_AUTH=prompt  — ask for a password on the terminal and read the
 *   reply, so a real pty round trip is exercised. Accepts FAKE_SSH_PASSWORD
 *   (default "hunter2").
 * - FAKE_SSH_AUTH=duo     — Duo's stateful two-stage menu, to prove a
 *   multi-prompt exchange works without PDV modelling any of it.
 * - FAKE_SSH_AUTH=fail    — refuse immediately, the way a rejected key does.
 * - FAKE_SSH_AUTH=hang    — never exit and never authenticate, for deadline tests.
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
let createMaster = false;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "-o") {
    const pair = argv[++i] || "";
    const eq = pair.indexOf("=");
    if (eq > 0) {
      // Strip surrounding double quotes exactly as real ssh does when it
      // parses an -o value as config-file syntax. PDV quotes ControlPath
      // because Electron's userData path contains a space on macOS, and a
      // fixture that kept the quotes would not be reproducing ssh.
      const value = pair.slice(eq + 1);
      options[pair.slice(0, eq)] =
        value.length > 1 && value.startsWith('"') && value.endsWith('"')
          ? value.slice(1, -1)
          : value;
    }
  } else if (arg === "-O") {
    controlCommand = argv[++i] || "";
  } else if (arg === "-N") {
    // No remote command: this invocation exists to create a master.
    createMaster = true;
  } else if (arg === "-T" || arg === "-t" || arg === "-q" || arg === "-f" || arg === "-M") {
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
  if (masterMode === "stateful") {
    if (!options.ControlPath) {
      die('No ControlPath specified for "-O" command', 255);
    }
    const held = fs.existsSync(options.ControlPath);
    if (controlCommand === "stop") {
      if (!held) die(`Control socket connect(${options.ControlPath}): No such file or directory`, 255);
      fs.rmSync(options.ControlPath, { force: true });
      process.stderr.write("Exit request sent.\n");
      process.exit(0);
    }
    if (!held) {
      die(`Control socket connect(${options.ControlPath}): No such file or directory`, 255);
    }
    process.stderr.write("Master running (pid=4242)\n");
    process.exit(0);
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

// --- master establishment (-N, the interactive auth path) ------------------
// Selected by FAKE_SSH_AUTH:
//   hold    — authenticate silently and STAY RUNNING, as a real foreground
//             master does (default).
//   ok      — authenticate and exit 0 immediately: a master that never
//             materialised, which must not be reported as success.
//   prompt  — ask for a password on the terminal and read the reply, so a
//             real pty round trip is exercised. Accepts FAKE_SSH_PASSWORD
//             (default "hunter2"), rejects anything else.
//   duo     — like `prompt`, but with Duo's two-stage menu, to prove a
//             stateful multi-prompt exchange works.
//   fail    — refuse immediately, the way a rejected key does.
//   hang    — never exit and never authenticate, for deadline tests.
if (createMaster) {
  const authMode = process.env.FAKE_SSH_AUTH || "hold";
  const expected = process.env.FAKE_SSH_PASSWORD || "hunter2";

  // The real master runs in the foreground for the life of the connection;
  // exiting would tell the caller the attempt is over. In stateful mode it
  // also publishes the socket, which is what makes -O check start answering.
  const hold = () => {
    if (masterMode === "stateful" && options.ControlPath) {
      try { fs.writeFileSync(options.ControlPath, String(process.pid)); } catch { /* ignore */ }
      const cleanup = () => { try { fs.rmSync(options.ControlPath, { force: true }); } catch { /* ignore */ } process.exit(0); };
      process.on("SIGTERM", cleanup);
      process.on("SIGHUP", cleanup);
      process.on("SIGINT", cleanup);
    }
    setInterval(() => {}, 1000);
  };

  if (authMode === "hold") { hold(); return; }
  if (authMode === "ok") process.exit(0);
  if (authMode === "hang") { hold(); return; }
  if (authMode === "fail") {
    die("Permission denied (publickey,keyboard-interactive).", 255);
  }

  // Read one line at a time from the terminal.
  const ask = (question, cb) => {
    process.stdout.write(question);
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      cb(buf.slice(0, nl).replace(/\r$/, ""));
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  };

  if (authMode === "duo") {
    process.stdout.write("Duo two-factor login for mpharr\n\n");
    ask("Passcode or option (1-3): ", (choice) => {
      if (choice.trim() !== "1") die("Invalid option", 255);
      process.stdout.write("Pushed a login request to your device...\n");
      ask("Password: ", (answer) => {
        if (answer !== expected) die("Permission denied, please try again.", 255);
        process.stdout.write("Success. Logging you in...\n");
        hold();
      });
    });
    return;
  }

  ask("mpharr@flux.pppl.gov's password: ", (answer) => {
    if (answer !== expected) die("Permission denied, please try again.", 255);
    hold();
  });
  return;
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

// stdin is inherited so `cat > file` works: the bundle upload streams its
// payload over stdin rather than passing it as an argument.
const child = spawn("/bin/sh", ["-c", command], { stdio: ["inherit", "inherit", "inherit"] });
child.on("close", (code) => process.exit(code === null ? 255 : code));
child.on("error", () => process.exit(255));
