/**
 * RemoteConnect — sign in to a remote host over ssh.
 *
 * Deliberately thin. It shows what ssh is saying, takes the one answer ssh
 * is waiting for, and gets out of the way; PDV models none of the auth
 * exchange itself, which is what lets a Duo menu, a passphrase and a host-key
 * confirmation all work without special cases.
 *
 * Two behaviours are load-bearing rather than cosmetic:
 *
 * - **The input masks itself when the prompt asks for something secret.**
 *   The shell decides that, not this component, and errs toward masking.
 * - **This connects; it does not move the session.** A successful connect
 *   leaves PDV running locally with an ssh connection open, so the wording
 *   never claims otherwise.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useStore } from '../../store';
import type { RemoteHostAlias } from '../../types';

interface RemoteConnectProps {
  /** Close the dialog. */
  onClose: () => void;
}

export const RemoteConnect: React.FC<RemoteConnectProps> = ({ onClose }) => {
  const phase = useStore((s) => s.remotePhase);
  const host = useStore((s) => s.remoteConnectHost);
  const node = useStore((s) => s.remoteNode);
  const log = useStore((s) => s.remoteLog);
  const secret = useStore((s) => s.remoteSecret);
  const message = useStore((s) => s.remoteMessage);
  const progress = useStore((s) => s.remoteProgress);
  const clearRemoteLog = useStore((s) => s.clearRemoteLog);

  const [hosts, setHosts] = useState<RemoteHostAlias[]>([]);
  /**
   * What the user has typed, or null if they have not. Derived rather than
   * synced from `host` in an effect: the live connection's host is only a
   * seed, and once anything is typed that wins.
   */
  const [typed, setTyped] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const logRef = useRef<HTMLPreElement>(null);
  const replyRef = useRef<HTMLInputElement>(null);

  const busy = phase === 'connecting' || phase === 'prompting' || phase === 'preparing';
  const connected = phase === 'connected';
  const [starting, setStarting] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const sessionRunning = useStore((s) => s.connectionState !== 'local');

  /** Move the session onto the connected host. */
  const startSession = async (): Promise<void> => {
    setStarting(true);
    setSessionError(null);
    try {
      const result = await window.pdv.remote.startSession();
      // A failure here leaves the local session working and the connection
      // open, so the dialog stays put and says why rather than closing.
      if (!result.ok) setSessionError(result.message ?? 'Could not start the session.');
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };
  // A reopened dialog shows what it is connected to rather than an empty box.
  const target = typed ?? host ?? '';

  useEffect(() => {
    void window.pdv.remote
      .listHosts()
      .then(setHosts)
      .catch(() => setHosts([]));
  }, []);

  useLayoutEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  // Focus the reply field the moment ssh starts waiting on an answer.
  useEffect(() => {
    if (phase === 'prompting') replyRef.current?.focus();
  }, [phase]);

  const handleConnect = (): void => {
    const trimmed = target.trim();
    if (!trimmed || busy) return;
    clearRemoteLog();
    void window.pdv.remote.connect(trimmed);
  };

  const handleReply = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!reply) return;
    void window.pdv.remote.respond(reply);
    // Cleared immediately: a secret must not linger in a DOM node, and the
    // next prompt in a multi-stage exchange needs an empty field anyway.
    setReply('');
  };

  return (
    <div className="remote-overlay">
      <div className="remote-panel">
        <div className="remote-title">Connect to Remote Host</div>

        {!busy && !connected && (
          <>
            <div className="remote-subtitle">
              Pick a host from your SSH config, or type any destination
              <code> ssh </code> understands.
            </div>
            <div className="remote-host-row">
              <input
                className="remote-host-input"
                list="remote-host-aliases"
                placeholder="host or user@host"
                value={target}
                autoFocus
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConnect();
                }}
              />
              <datalist id="remote-host-aliases">
                {hosts.map((entry) => (
                  <option key={entry.alias} value={entry.alias}>
                    {entry.hostName ?? ''}
                  </option>
                ))}
              </datalist>
              <button
                className="btn btn-primary"
                disabled={!target.trim()}
                onClick={handleConnect}
              >
                Connect
              </button>
            </div>
          </>
        )}

        {connected && (
          <div className="remote-connected">
            <div className="remote-connected-host">
              Connected to <strong>{host}</strong>
              {node && node !== host && <span className="remote-node"> ({node})</span>}
            </div>
            <div className="remote-subtitle">
              {sessionRunning
                ? `Your session is running on ${host ?? 'this host'}.`
                : 'This session still runs on your computer. Run it on ' +
                  `${host ?? 'this host'} to use its data and compute.`}
            </div>
            {sessionError && <div className="remote-error">{sessionError}</div>}
          </div>
        )}

        {busy && (
          <div className="remote-subtitle">
            {phase === 'prompting'
              ? `${host} is asking for something — answer below.`
              : phase === 'preparing'
                ? message ?? `Setting up ${host}…`
                : `Contacting ${host}… this can take a while if it needs approval on your phone or in your password manager.`}
          </div>
        )}

        {/* Only while a transfer is actually running: a probe or a checksum
            is over before a progress bar would mean anything. */}
        {phase === 'preparing' && progress && progress.total > 0 && (
          <div className="remote-progress">
            <div
              className="remote-progress-fill"
              style={{ width: `${Math.round((progress.transferred / progress.total) * 100)}%` }}
            />
          </div>
        )}

        {log && (
          <pre className="remote-log" ref={logRef}>
            {log}
          </pre>
        )}

        {phase === 'failed' && message && <div className="remote-error">{message}</div>}

        {phase === 'prompting' && (
          <form className="remote-reply-row" onSubmit={handleReply}>
            <input
              ref={replyRef}
              className="remote-reply-input"
              type={secret ? 'password' : 'text'}
              value={reply}
              autoComplete="off"
              placeholder={secret ? 'Hidden while you type' : 'Your answer'}
              onChange={(e) => setReply(e.target.value)}
            />
            <button className="btn btn-primary" type="submit" disabled={!reply}>
              Send
            </button>
          </form>
        )}

        <div className="remote-actions">
          {busy && (
            <button className="btn btn-secondary" onClick={() => void window.pdv.remote.cancel()}>
              Cancel
            </button>
          )}
          {connected && !sessionRunning && (
            <button
              className="btn btn-primary"
              disabled={starting}
              onClick={() => void startSession()}
            >
              {starting ? 'Starting…' : 'Run session here'}
            </button>
          )}
          {connected && (
            <button
              className="btn btn-secondary"
              onClick={() => void window.pdv.remote.disconnect()}
            >
              Disconnect
            </button>
          )}
          <button className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
