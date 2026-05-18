/**
 * AgentsTab — presentational component for the Settings → Agents tab.
 *
 * Shows how to connect an external AI agent (Claude Code, Codex, Cursor) to
 * PDV's local MCP server: connection status, the endpoint URL and bearer
 * token, copy-paste setup snippets, and the two agent-capability toggles.
 *
 * State is owned locally — the MCP status is fetched once on mount via
 * `window.pdv.mcp.getStatus()`, and the capability toggles are read from /
 * written to `window.pdv.config.*` directly. Unlike the other tabs, the
 * Agents tab does not participate in the dialog-level Save button.
 */

import React, { useCallback, useEffect, useState } from 'react';
import type { Config, McpStatus } from '../../types';

/** Capability flags persisted under `config.mcp`. */
type McpToggleKey = 'mutatingToolsEnabled' | 'pdvRunEnabled';

/** Placeholder values shown in snippets before the server is running. */
const URL_PLACEHOLDER = '<not running>';
const TOKEN_PLACEHOLDER = '<not running>';

/**
 * A monospace value paired with a Copy button. Renders a transient
 * "Copied" confirmation after a successful clipboard write.
 */
const CopyField: React.FC<{ label: string; value: string | null }> = ({ label, value }) => {
  const [copied, setCopied] = useState(false);
  const display = value ?? URL_PLACEHOLDER;
  const canCopy = value != null;

  const handleCopy = useCallback(() => {
    if (!canCopy) return;
    void navigator.clipboard.writeText(value!).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  }, [canCopy, value]);

  return (
    <div className="agents-field">
      <span className="agents-field-label">{label}</span>
      <code className="agents-field-value">{display}</code>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={handleCopy}
        disabled={!canCopy}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
};

/**
 * A labelled copy-paste code block with a Copy button in its header.
 */
const SnippetBlock: React.FC<{ title: string; snippet: string }> = ({ title, snippet }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(snippet).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  }, [snippet]);

  return (
    <div className="agents-snippet">
      <div className="agents-snippet-header">
        <span className="agents-snippet-title">{title}</span>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={handleCopy}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="agents-snippet-body">{snippet}</pre>
    </div>
  );
};

/** Settings → Agents tab. Self-contained; owns its own MCP + config state. */
export const AgentsTab: React.FC = () => {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [mcpConfig, setMcpConfig] = useState<NonNullable<Config['mcp']>>({});

  // Fetch the MCP server status and persisted capability flags on mount.
  useEffect(() => {
    let cancelled = false;
    void window.pdv.mcp.getStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    void window.pdv.config.get().then((cfg) => {
      if (!cancelled) setMcpConfig(cfg.mcp ?? {});
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const running = status?.running ?? false;
  const url = status?.url ?? null;
  const token = status?.token ?? null;

  // Snippet values fall back to obvious placeholders when not running.
  const snippetUrl = url ?? URL_PLACEHOLDER;
  const snippetToken = token ?? TOKEN_PLACEHOLDER;

  const claudeSnippet =
    `claude mcp add --transport http pdv ${snippetUrl} ` +
    `--header "Authorization: Bearer ${snippetToken}"`;

  const jsonSnippet = [
    '{',
    '  "mcpServers": {',
    '    "pdv": {',
    `      "url": "${snippetUrl}",`,
    '      "headers": {',
    `        "Authorization": "Bearer ${snippetToken}"`,
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');

  /** Persist a single capability flag, merging with the current `mcp` block. */
  const handleToggle = useCallback(
    (key: McpToggleKey, value: boolean) => {
      setMcpConfig((prev) => {
        const next = { ...prev, [key]: value };
        void window.pdv.config.set({ mcp: next });
        return next;
      });
    },
    [],
  );

  return (
    <div className="settings-agents">
      <p className="settings-general-hint">
        PDV runs a local MCP server so an AI agent can read and act on the
        current project. Connect your agent using the details below.
      </p>

      {/* ── Connection status ── */}
      <div className="appearance-section-header">Connection</div>
      <div className="agents-status">
        <span
          className={`agents-status-dot ${running ? 'agents-status-dot--on' : 'agents-status-dot--off'}`}
          aria-hidden="true"
        />
        <span className="agents-status-text">
          {running && status?.port != null ? (
            <>
              MCP server running on{' '}
              <code className="agents-inline-code">
                {status.host}:{status.port}
              </code>
            </>
          ) : (
            'MCP server is not running.'
          )}
        </span>
      </div>

      <CopyField label="Endpoint URL" value={url} />
      <CopyField label="Bearer token" value={token} />

      {/* ── Setup snippets ── */}
      <div className="appearance-section-header appearance-section-header--spaced">
        Connect an agent
      </div>
      <SnippetBlock title="Claude Code" snippet={claudeSnippet} />
      <SnippetBlock title="Codex / Cursor (config JSON)" snippet={jsonSnippet} />

      {/* ── Capability toggles ── */}
      <div className="appearance-section-header appearance-section-header--spaced">
        Agent capabilities
      </div>
      <label className="appearance-editor-check agents-toggle">
        <input
          type="checkbox"
          checked={mcpConfig.mutatingToolsEnabled ?? false}
          onChange={(e) => handleToggle('mutatingToolsEnabled', e.target.checked)}
        />
        <span>Allow agent write tools</span>
      </label>
      <div className="settings-agents-desc">
        Lets agents create, modify, and delete tree nodes. Off until the
        trust model lands.
      </div>

      <label className="appearance-editor-check agents-toggle">
        <input
          type="checkbox"
          checked={mcpConfig.pdvRunEnabled ?? false}
          onChange={(e) => handleToggle('pdvRunEnabled', e.target.checked)}
        />
        <span>Allow pdv_run (agent runs code in the kernel)</span>
      </label>
      <div className="settings-agents-desc">
        Lets agents execute arbitrary code in the project kernel. Off until
        the trust model lands.
      </div>
    </div>
  );
};
