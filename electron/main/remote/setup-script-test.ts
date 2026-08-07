/**
 * setup-script-test.ts — dry-run a setup script on the connected host.
 *
 * The daemon's login-environment capture deliberately discards everything a
 * setup script prints (`server/login-env.ts` — chatter would corrupt probe
 * parsing), which makes it a terrible place to debug one. This module is
 * the debugging surface: it sources the *candidate* content — what is in
 * the editor right now, not what was last saved or last shipped — in a real
 * `bash -l` on the host, captures the script's own output verbatim, and
 * probes which interpreters a login shell can see before and after.
 *
 * Everything rides one marker-framed protocol on stdout. A login shell
 * prints banners and Lmod chatter on its own account, so nothing is
 * position-dependent: probe results are `PDVPROBE:`-prefixed lines and the
 * script's output travels between explicit BEGIN/END markers, written after
 * the source completes so the two cannot interleave.
 *
 * This module does NOT ship the session's real script (`setup-script.ts`
 * does, at session start) and does NOT touch the daemon — a test never
 * changes what a running session sources.
 */

import type { RemoteSetupTestInterpreter, RemoteSetupTestResult } from "../ipc";
import { posixShellQuote } from "../editor-spawn";
import { execViaSsh, type SshControl } from "./ssh-mux";

/** Commands probed on the host, in report order. */
export const PROBED_INTERPRETERS = ["python3", "julia"] as const;

/**
 * Generous by exec standards: a `julia --version` from a cold NFS mount can
 * take seconds, and the whole point of the button is to run on loaded
 * cluster login nodes.
 */
const TEST_TIMEOUT_MS = 60_000;

/** Options for {@link runSetupScriptTest}. */
export interface RunSetupScriptTestOptions {
  /** Live control connection to the host. */
  control: SshControl;
  /** Candidate script content (the editor's current text). */
  content: string;
  /** `ssh` binary override (the PDV_SSH_PATH seam). */
  sshPath?: string;
  /** Injected by tests; production uses {@link execViaSsh}. */
  exec?: typeof execViaSsh;
}

/** The marker-framed probe fragment, shared by both shells. */
const PROBE_FRAGMENT = PROBED_INTERPRETERS.map(
  (name) =>
    `p=$(command -v ${name} 2>/dev/null || true); ` +
    `printf 'PDVPROBE:%s:%s\\n' ${name} "$p"; ` +
    `if [ -n "$p" ]; then v=$("$p" --version 2>&1 | head -n 1); ` +
    `printf 'PDVVERSION:%s:%s\\n' ${name} "$v"; fi; `,
).join("");

/** Parse `PDVPROBE:`/`PDVVERSION:` lines into the report shape. */
function parseProbes(stdout: string): RemoteSetupTestInterpreter[] {
  const paths = new Map<string, string | null>();
  const versions = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const probe = /^PDVPROBE:([^:]+):(.*)$/.exec(line);
    if (probe) paths.set(probe[1], probe[2].trim() || null);
    const version = /^PDVVERSION:([^:]+):(.*)$/.exec(line);
    if (version) versions.set(version[1], version[2].trim());
  }
  return PROBED_INTERPRETERS.map((name) => ({
    name,
    path: paths.get(name) ?? null,
    version: versions.get(name) ?? null,
  }));
}

/** Extract the script's captured output from between its markers. */
function parseScriptOutput(stdout: string): { exitCode: number | null; output: string } {
  // LAST match on purpose: the script's replayed output precedes the
  // genuine line, so a script that itself prints `PDVSOURCERC:0` must not
  // spoof the verdict. (Same reason `end` is a lastIndexOf.)
  const rcs = [...stdout.matchAll(/^PDVSOURCERC:(-?\d+)$/gm)];
  const rc = rcs.length > 0 ? rcs[rcs.length - 1] : null;
  const begin = stdout.indexOf("PDVOUTPUT-BEGIN\n");
  const end = stdout.lastIndexOf("PDVOUTPUT-END");
  let output = "";
  if (begin !== -1 && end > begin) {
    output = stdout.slice(begin + "PDVOUTPUT-BEGIN\n".length, end);
  }
  return { exitCode: rc ? Number(rc[1]) : null, output: output.trimEnd() };
}

/**
 * Source a candidate setup script on the host and report what it did.
 *
 * Two `bash -l` invocations: one plain (the baseline), one that writes the
 * content to a private temp file, sources it with output captured, and then
 * probes in that same shell — so the after-probe sees exactly the PATH the
 * script produced. The temp file is removed in the same invocation.
 *
 * @param options - Connection and candidate content.
 * @returns The report. Resolves for every outcome; transport failures are
 *   reported in `message` rather than thrown, since "the test could not
 *   run" is a result the tab must render, not an exception.
 */
export async function runSetupScriptTest(
  options: RunSetupScriptTestOptions,
): Promise<RemoteSetupTestResult> {
  const exec = options.exec ?? execViaSsh;
  const muxOptions = { sshPath: options.sshPath, timeoutMs: TEST_TIMEOUT_MS };
  // Lone \r normalized too — a mac-classic line ending is as corrosive
  // inside an exported value as a CRLF.
  const content = options.content.replace(/\r\n?/g, "\n");

  const baselineRun = await exec(
    options.control,
    `bash -lc ${posixShellQuote(PROBE_FRAGMENT)}`,
    muxOptions,
  );
  if (!baselineRun.ok && baselineRun.exitCode === null) {
    return {
      ok: false,
      exitCode: null,
      output: "",
      before: [],
      after: [],
      message:
        `The test could not reach the host: ` +
        `${baselineRun.stderr.trim() || (baselineRun.failure ?? "unknown failure")}`,
    };
  }
  const before = parseProbes(baselineRun.stdout);

  // Source with output redirected to a file, then replay it between
  // markers AFTER the source finishes — capturing live would interleave
  // the script's output with the markers and the probes.
  // Both redirects write to files mktemp ALREADY CREATED, so they must be
  // `>|` (clobber-override): a login shell whose profile sets `noclobber`
  // (observed on flux) refuses plain `>`, the candidate script is never
  // written, and an empty file gets sourced — the redirect's rc=1 was then
  // misreported as the script's own exit status.
  const inner =
    `s=$(mktemp) && o=$(mktemp) || exit 90; ` +
    `printf '%s' ${posixShellQuote(content)} >| "$s"; ` +
    `. "$s" >| "$o" 2>&1; rc=$?; ` +
    `printf 'PDVSOURCERC:%s\\n' "$rc"; ` +
    `printf 'PDVOUTPUT-BEGIN\\n'; cat "$o"; printf '\\nPDVOUTPUT-END\\n'; ` +
    `rm -f "$s" "$o"; ` +
    PROBE_FRAGMENT;
  const scriptedRun = await exec(
    options.control,
    `bash -lc ${posixShellQuote(inner)}`,
    muxOptions,
  );
  if (!scriptedRun.ok && scriptedRun.exitCode === null) {
    return {
      ok: false,
      exitCode: null,
      output: "",
      before,
      after: [],
      message:
        `The host stopped answering mid-test: ` +
        `${scriptedRun.stderr.trim() || (scriptedRun.failure ?? "unknown failure")}`,
    };
  }

  // Probes are parsed only AFTER the output-replay region: a script that
  // prints its own `PDVPROBE:`/`PDVVERSION:` lines would otherwise inject
  // rows into the report (the replay precedes the genuine probes).
  const probeRegion = (() => {
    const end = scriptedRun.stdout.lastIndexOf("PDVOUTPUT-END");
    return end === -1 ? scriptedRun.stdout : scriptedRun.stdout.slice(end);
  })();
  const { exitCode, output } = parseScriptOutput(scriptedRun.stdout);
  if (exitCode === null) {
    // The shell died before the markers were printed. The overwhelmingly
    // likely cause is an `exit` line in the script: it is *sourced*, so
    // `exit` ends the surrounding shell — this test's, and equally the
    // daemon's capture shell at session start.
    return {
      ok: false,
      exitCode: scriptedRun.exitCode,
      output,
      before,
      after: parseProbes(probeRegion),
      message:
        "The script ended the shell before the test could finish. Setup " +
        "scripts are sourced, so an `exit` line closes the session's shell " +
        "too — remove it and rely on the script reaching its end.",
    };
  }
  return {
    ok: exitCode === 0,
    exitCode,
    output,
    before,
    after: parseProbes(probeRegion),
  };
}
