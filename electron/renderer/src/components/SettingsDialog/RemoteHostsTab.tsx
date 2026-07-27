/**
 * RemoteHostsTab — per-host remote configuration (Settings → Remote Hosts).
 *
 * One page per host: the setup script sourced when a session starts there
 * (with a Test button that dry-runs the *editor's current text* in a real
 * login shell on the host), the directories PDV should use on that cluster,
 * and the kernel-launch configuration the Slurm work will consume.
 *
 * Self-contained rather than riding the dialog-wide Save: host config is
 * not part of `PDVConfig` (it is per-host, stored in the shell's
 * remote-hosts.json + one script file per host), so this tab owns its own
 * load/save cycle like AgentsTab does. Edits live in per-host drafts —
 * switching hosts parks a draft instead of destroying it, and the Save
 * button writes only the selected host.
 */

import React, { useCallback, useEffect, useState } from 'react';

import { useStore } from '../../store';
import type {
  RemoteHostAlias,
  RemoteHostSettings,
  RemoteSetupTestResult,
} from '../../types';

/** One host's in-progress edits plus the loaded baseline for dirtiness. */
interface HostDraft {
  settings: RemoteHostSettings;
  setupScript: string;
  /** Concrete node the session daemon was last seen on (display only). */
  sessionNode: string | null;
  /** Serialized loaded state; the draft is dirty when it differs. */
  baseline: string;
}

/**
 * The dirty-comparison view of a draft. Canonical key order, so clearing a
 * field and retyping the identical value compares clean — JSON.stringify
 * of the raw objects was insertion-order-sensitive.
 */
const serialize = (draft: Pick<HostDraft, 'settings' | 'setupScript'>): string => {
  const launch = draft.settings.launch;
  return JSON.stringify({
    workingDirBase: draft.settings.workingDirBase ?? null,
    defaultSaveLocation: draft.settings.defaultSaveLocation ?? null,
    launch: launch
      ? {
          mode: launch.mode,
          allocationCommand: launch.allocationCommand ?? null,
          account: launch.account ?? null,
          partition: launch.partition ?? null,
        }
      : null,
    setupScript: draft.setupScript,
  });
};

/**
 * Dirty drafts survive the component unmounting — module scope on purpose.
 * The dirty dot advertises that a parked edit is safe; letting a peek at
 * the Appearance tab (which unmounts this one) destroy it would make that
 * a lie. Clean entries are never cached, so a fresh mount refetches them.
 */
const parkedDrafts = new Map<string, HostDraft>();

/** Test-only: reset the module-scoped draft cache between tests. */
export function clearParkedDraftsForTests(): void {
  parkedDrafts.clear();
}

/** Interpreter rows worth calling out: what the script changed. */
function probeChange(
  result: RemoteSetupTestResult,
  name: string,
): { before: string; after: string; changed: boolean } {
  const before = result.before.find((i) => i.name === name);
  const after = result.after.find((i) => i.name === name);
  const show = (probe?: { path: string | null; version: string | null }): string =>
    probe?.path ? `${probe.path}${probe.version ? ` — ${probe.version}` : ''}` : 'not found';
  return {
    before: show(before),
    after: show(after),
    changed: (before?.path ?? null) !== (after?.path ?? null),
  };
}

/** Per-host remote configuration tab body. */
export const RemoteHostsTab: React.FC = () => {
  const [aliases, setAliases] = useState<RemoteHostAlias[]>([]);
  const [configured, setConfigured] = useState<string[]>([]);
  const [extraHosts, setExtraHosts] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, HostDraft>>(() =>
    Object.fromEntries(parkedDrafts),
  );
  const [addText, setAddText] = useState('');
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<RemoteSetupTestResult | null>(null);

  // Whether the Test button can reach the selected host right now.
  const remotePhase = useStore((s) => s.remotePhase);
  const remoteConnectHost = useStore((s) => s.remoteConnectHost);
  const connectedToSelected =
    remotePhase === 'connected' && selected !== null && remoteConnectHost === selected;

  // The host list: ssh-config aliases plus anything already configured plus
  // hosts added by hand this session. Aliases keep config order (the user's
  // own ordering); the rest append alphabetically.
  const aliasNames = aliases.map((a) => a.alias);
  const hosts = [
    ...aliasNames,
    ...[...new Set([...configured, ...extraHosts])]
      .filter((h) => !aliasNames.includes(h))
      .sort(),
  ];

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [aliasList, configuredList] = await Promise.all([
        window.pdv.remote.listHosts().catch(() => [] as RemoteHostAlias[]),
        window.pdv.remote.listConfiguredHosts().catch(() => [] as string[]),
      ]);
      if (cancelled) return;
      setAliases(aliasList);
      setConfigured(configuredList);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Default selection once the lists arrive: the connected host if it is
  // listed, else the first host.
  useEffect(() => {
    if (selected !== null || hosts.length === 0) return;
    const preferred =
      remoteConnectHost && hosts.includes(remoteConnectHost) ? remoteConnectHost : hosts[0];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot default selection once the async host lists arrive
    setSelected(preferred);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hosts is derived; keyed on its inputs
  }, [aliases, configured, extraHosts, selected, remoteConnectHost]);

  // Load the selected host's config into a draft, once per host.
  useEffect(() => {
    if (selected === null || drafts[selected]) return;
    let cancelled = false;
    void window.pdv.remote.getHostConfig(selected).then((payload) => {
      if (cancelled) return;
      setDrafts((prev) => ({
        ...prev,
        [selected]: {
          settings: payload.settings,
          setupScript: payload.setupScript,
          sessionNode: payload.sessionNode,
          baseline: serialize(payload),
        },
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [selected, drafts]);

  const draft = selected !== null ? drafts[selected] : undefined;
  const dirty = draft !== undefined && serialize(draft) !== draft.baseline;

  // Mirror dirty drafts into the module cache (see parkedDrafts).
  useEffect(() => {
    for (const [host, draft] of Object.entries(drafts)) {
      if (serialize(draft) !== draft.baseline) parkedDrafts.set(host, draft);
      else parkedDrafts.delete(host);
    }
  }, [drafts]);

  /** Apply a partial edit to the selected host's draft. */
  const edit = useCallback(
    (change: Partial<Pick<HostDraft, 'settings' | 'setupScript'>>): void => {
      if (selected === null) return;
      setSaveStatus(null);
      // A verdict describes the exact bytes that were tested; editing them
      // makes it a statement about text that no longer exists.
      setTestResult(null);
      setDrafts((prev) => {
        const current = prev[selected];
        if (!current) return prev;
        return { ...prev, [selected]: { ...current, ...change } };
      });
    },
    [selected],
  );

  const editSettings = useCallback(
    (change: Partial<RemoteHostSettings>): void => {
      if (selected === null) return;
      setSaveStatus(null);
      setDrafts((prev) => {
        const current = prev[selected];
        if (!current) return prev;
        const settings = { ...current.settings, ...change };
        // Empty strings mean "cleared" — drop the key so the saved shape
        // matches what the store persists and dirtiness stays honest.
        for (const key of ['workingDirBase', 'defaultSaveLocation'] as const) {
          if (settings[key] !== undefined && !settings[key].trim()) delete settings[key];
        }
        return { ...prev, [selected]: { ...current, settings } };
      });
    },
    [selected],
  );

  const save = useCallback(async (): Promise<void> => {
    if (selected === null || !draft) return;
    // Baseline what was actually SENT, not the post-await draft: keystrokes
    // that land during the round trip must stay dirty, or they read as
    // saved while only the older snapshot reached disk.
    const sent = { settings: draft.settings, setupScript: draft.setupScript };
    try {
      await window.pdv.remote.setHostConfig(selected, sent);
      setDrafts((prev) => {
        const current = prev[selected];
        if (!current) return prev;
        return { ...prev, [selected]: { ...current, baseline: serialize(sent) } };
      });
      setConfigured(await window.pdv.remote.listConfiguredHosts().catch(() => configured));
      setSaveStatus('Saved. Directory and script changes apply the next time a session starts on this host.');
    } catch (err) {
      setSaveStatus(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [selected, draft, configured]);

  const runTest = useCallback(async (): Promise<void> => {
    if (selected === null || !draft) return;
    setTestRunning(true);
    setTestResult(null);
    try {
      setTestResult(await window.pdv.remote.testSetupScript(selected, draft.setupScript));
    } catch (err) {
      setTestResult({
        ok: false,
        exitCode: null,
        output: '',
        before: [],
        after: [],
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTestRunning(false);
    }
  }, [selected, draft]);

  const forget = useCallback(
    async (host: string): Promise<void> => {
      if (
        !window.confirm(
          `Forget ${host}? Its setup script and settings on this computer ` +
            `are deleted. Nothing on ${host} itself is touched.`,
        )
      ) {
        return;
      }
      try {
        await window.pdv.remote.forgetHost(host);
      } catch {
        return; // Nothing was deleted; leave the UI as it was.
      }
      parkedDrafts.delete(host);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[host];
        return next;
      });
      setExtraHosts((prev) => prev.filter((h) => h !== host));
      setConfigured(await window.pdv.remote.listConfiguredHosts().catch(() => []));
      if (selected === host) {
        setSelected(null); // The default-selection effect picks a survivor.
        setTestResult(null);
        setSaveStatus(null);
      }
    },
    [selected],
  );

  const launch = draft?.settings.launch;
  const launchMode = launch?.mode ?? 'login-node';

  return (
    <div className="settings-remote">
      <div className="settings-remote-hosts">
        <div className="settings-remote-hosts-heading">Hosts</div>
        <ul className="settings-remote-host-list">
          {hosts.map((host) => {
            const hostDraft = drafts[host];
            const hostDirty =
              hostDraft !== undefined && serialize(hostDraft) !== hostDraft.baseline;
            return (
              <li key={host}>
                <button
                  type="button"
                  className={`settings-remote-host${host === selected ? ' active' : ''}`}
                  onClick={() => {
                    setSelected(host);
                    setTestResult(null);
                    setSaveStatus(null);
                  }}
                >
                  <span className="settings-remote-host-name" title={host}>
                    {host}
                  </span>
                  {hostDirty && (
                    <span
                      className="settings-remote-host-dirty"
                      title="Unsaved changes"
                    >
                      ●
                    </span>
                  )}
                  {(configured.includes(host) || extraHosts.includes(host)) && (
                    <span
                      className="settings-remote-host-remove"
                      role="button"
                      aria-label={`Forget ${host}`}
                      title={`Forget ${host}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void forget(host);
                      }}
                    >
                      ×
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="settings-remote-add-row">
          <input
            type="text"
            value={addText}
            placeholder="user@host"
            spellCheck={false}
            onChange={(e) => setAddText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const trimmed = addText.trim();
              if (!trimmed) return;
              setExtraHosts((prev) => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
              setSelected(trimmed);
              // Same clears as the list-button path — a verdict from the
              // previous host must not sit under this one's empty script.
              setTestResult(null);
              setSaveStatus(null);
              setAddText('');
            }}
          />
        </div>
        <div className="settings-remote-hosts-hint">
          Hosts come from your SSH config; type any other destination above
          and press Enter.
        </div>
      </div>

      <div className="settings-remote-editor">
        {selected === null || !draft ? (
          <p className="settings-general-hint">
            {hosts.length === 0
              ? 'No hosts found in your SSH config. Type a destination on the left to configure one.'
              : 'Loading…'}
          </p>
        ) : (
          <>
            {draft.sessionNode && (
              <p className="settings-remote-node-note">
                Your session on this host was last seen on{' '}
                <code>{draft.sessionNode}</code> — reconnects aim there
                automatically.
              </p>
            )}

            <h4 className="settings-general-section">Setup script</h4>
            <p className="settings-general-hint">
              Sourced by a login shell when a session starts on{' '}
              <strong>{selected}</strong> — put <code>module load</code> lines,
              conda activation, or PATH changes here. Applies when the
              session&rsquo;s daemon starts; an already-running session needs a
              shut-down and restart to pick up changes.
            </p>
            <textarea
              className="settings-remote-script"
              value={draft.setupScript}
              spellCheck={false}
              placeholder={'# e.g.\n# module load python/3.12\n# module load julia'}
              onChange={(e) => edit({ setupScript: e.target.value })}
            />
            <div className="settings-remote-test-row">
              <button
                className="btn btn-secondary btn-sm"
                type="button"
                disabled={!connectedToSelected || testRunning || !draft.setupScript.trim()}
                title={
                  !connectedToSelected
                    ? `Connect to ${selected} first — the test runs on the host`
                    : !draft.setupScript.trim()
                      ? 'Write a script first, then test it here'
                      : 'Source this script in a login shell on the host and report what it changes'
                }
                onClick={() => void runTest()}
              >
                {testRunning ? 'Testing…' : 'Test on host'}
              </button>
              {!connectedToSelected ? (
                <span className="settings-remote-inline-hint">
                  Connect to {selected} to test the script.
                </span>
              ) : !draft.setupScript.trim() ? (
                <span className="settings-remote-inline-hint">
                  Write a script first, then test it here.
                </span>
              ) : null}
            </div>

            {testResult && (
              <div className="settings-remote-test-result">
                {testResult.message ? (
                  <div role="alert" className="settings-general-error">
                    {testResult.message}
                  </div>
                ) : (
                  <div
                    className={
                      testResult.ok
                        ? 'settings-remote-test-verdict ok'
                        : 'settings-remote-test-verdict failed'
                    }
                  >
                    {testResult.ok
                      ? 'Script sourced cleanly.'
                      : `Script exited with status ${String(testResult.exitCode ?? '?')}.`}
                  </div>
                )}
                {testResult.output && (
                  <>
                    <div className="settings-remote-output-label">
                      Output from the script
                    </div>
                    <pre className="settings-remote-test-output">{testResult.output}</pre>
                  </>
                )}
                {/* No probe table under a message: the probes did not run
                    (or cannot be trusted), and "python3: not found" rows
                    would read as the script BREAKING python. */}
                {!testResult.message && testResult.after.length > 0 && (
                  <table className="settings-remote-probe-table">
                    <thead>
                      <tr>
                        <th></th>
                        <th>Without script</th>
                        <th>With script</th>
                      </tr>
                    </thead>
                    <tbody>
                      {testResult.after.map(({ name }) => {
                        const change = probeChange(testResult, name);
                        return (
                          <tr key={name} className={change.changed ? 'changed' : ''}>
                            <td>
                              <code>{name}</code>
                            </td>
                            <td>{change.before}</td>
                            <td>{change.after}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            )}

            <h4 className="settings-general-section">Directories on {selected}</h4>
            <div className="settings-general-grid">
              <label htmlFor="sr-working-dir">Working directory</label>
              <input
                id="sr-working-dir"
                type="text"
                value={draft.settings.workingDirBase ?? ''}
                placeholder="e.g. /scratch/<user>/pdv"
                spellCheck={false}
                onChange={(e) => editSettings({ workingDirBase: e.target.value })}
              />
              <div className="settings-general-desc">
                Where per-project working files go on this host. Prefer scratch
                over an NFS home — but mind purge policies (PPPL:{' '}
                <code>/scratch/local</code> is purged after 3 days,{' '}
                <code>/scratch/shared</code> after 7). Blank uses the
                host&rsquo;s default.
              </div>

              <label htmlFor="sr-save-loc">Default save location</label>
              <input
                id="sr-save-loc"
                type="text"
                value={draft.settings.defaultSaveLocation ?? ''}
                placeholder="e.g. /p/myproject/<user>"
                spellCheck={false}
                onChange={(e) => editSettings({ defaultSaveLocation: e.target.value })}
              />
              <div className="settings-general-desc">
                Pre-filled location when saving projects on this host. Saved
                projects should NOT live in purged scratch space.
              </div>
            </div>

            <h4 className="settings-general-section">Kernel launch</h4>
            <div className="settings-general-grid">
              <label htmlFor="sr-launch-mode">Run kernels</label>
              <select
                id="sr-launch-mode"
                value={launchMode}
                onChange={(e) =>
                  editSettings({
                    launch: {
                      ...launch,
                      mode: e.target.value as 'login-node' | 'slurm',
                    },
                  })
                }
              >
                <option value="login-node">On the login node</option>
                <option value="slurm">In a Slurm allocation</option>
              </select>
              <div className="settings-general-desc">
                {launchMode === 'login-node' ? (
                  <>
                    Fine for interactive analysis; keep heavy compute in batch
                    jobs — sites cap login-node usage.
                  </>
                ) : (
                  <>
                    Saved now, used when Slurm-launched kernels ship in an
                    upcoming update. Until then kernels start on the login
                    node.
                  </>
                )}
              </div>

              {launchMode === 'slurm' && (
                <>
                  <label htmlFor="sr-slurm-account">Account</label>
                  <input
                    id="sr-slurm-account"
                    type="text"
                    value={launch?.account ?? ''}
                    placeholder="-A value, e.g. myproject"
                    spellCheck={false}
                    onChange={(e) =>
                      editSettings({
                        launch: { mode: 'slurm', ...launch, account: e.target.value || undefined },
                      })
                    }
                  />
                  <div className="settings-general-desc">Slurm account to charge.</div>

                  <label htmlFor="sr-slurm-partition">Partition</label>
                  <input
                    id="sr-slurm-partition"
                    type="text"
                    value={launch?.partition ?? ''}
                    placeholder="-p value, e.g. general"
                    spellCheck={false}
                    onChange={(e) =>
                      editSettings({
                        launch: { mode: 'slurm', ...launch, partition: e.target.value || undefined },
                      })
                    }
                  />
                  <div className="settings-general-desc">Slurm partition to request.</div>

                  <label htmlFor="sr-slurm-cmd">Allocation command</label>
                  <input
                    id="sr-slurm-cmd"
                    type="text"
                    value={launch?.allocationCommand ?? ''}
                    placeholder="optional — overrides account/partition"
                    spellCheck={false}
                    onChange={(e) =>
                      editSettings({
                        launch: {
                          mode: 'slurm',
                          ...launch,
                          allocationCommand: e.target.value || undefined,
                        },
                      })
                    }
                  />
                  <div className="settings-general-desc">
                    Full <code>srun</code>/<code>salloc</code> prefix for the
                    kernel, when the fields above are not enough.
                  </div>
                </>
              )}
            </div>

            <div className="settings-remote-save-row">
              <button
                className="btn btn-primary"
                type="button"
                disabled={!dirty}
                onClick={() => void save()}
              >
                Save {selected}
              </button>
              {saveStatus && (
                <span className="settings-remote-inline-hint">{saveStatus}</span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
