/**
 * ActivityBar — Vertical icon strip along the left edge of the app.
 *
 * Controls which left sidebar panel is visible (tree, namespace),
 * shows dynamic icons for imported GUI modules, and provides access to
 * settings and the external-app launchers. Launcher buttons read the
 * session's connection state from the store to route their affordances:
 * the terminal/working-dir launchers work in remote sessions (over ssh /
 * Remote-SSH), while the agent launcher is local-only (MCP does not run
 * remotely) and disables itself with an explanatory tooltip.
 */

import React from 'react';
import { TreeIcon, NamespaceIcon, SettingsIcon, AgentIcon, FolderCodeIcon, TerminalIcon } from '../Icons';
import { useStore } from '../../store';

type LeftPanel = 'tree' | 'namespace';

interface ActivityBarProps {
  leftSidebarOpen: boolean;
  leftPanel: LeftPanel;
  onActivityBarClick: (panel: LeftPanel) => void;
  onSettingsClick: () => void;
  onAgentClick: () => void;
  onOpenWorkingDir: () => void;
  onOpenTerminal: () => void;
  guiModules?: { alias: string; name: string }[];
  kernelId: string | null;
}

/** Vertical activity bar with panel toggle buttons, module launchers, and settings. */
export const ActivityBar: React.FC<ActivityBarProps> = ({
  leftSidebarOpen,
  leftPanel,
  onActivityBarClick,
  onSettingsClick,
  onAgentClick,
  onOpenWorkingDir,
  onOpenTerminal,
  guiModules = [],
  kernelId,
}) => {
  const isRemote = useStore((s) => s.connectionState !== 'local');
  const remoteHost = useStore((s) => s.remoteHost);
  return (
  <nav className="activity-bar">
    <div className="activity-bar-top">
      <button
        className={`activity-btn${leftSidebarOpen && leftPanel === 'tree' ? ' active' : ''}`}
        onClick={() => onActivityBarClick('tree')}
        title="Tree (Cmd+B)"
      >
        <TreeIcon />
      </button>
      <button
        className={`activity-btn${leftSidebarOpen && leftPanel === 'namespace' ? ' active' : ''}`}
        onClick={() => onActivityBarClick('namespace')}
        title="Namespace"
      >
        <NamespaceIcon />
      </button>
      {guiModules.length > 0 && (
        <>
          <div className="activity-bar-divider" />
          {guiModules.map((mod) => (
            <button
              key={mod.alias}
              className="activity-btn activity-btn-module"
              onClick={() => {
                if (kernelId) {
                  void window.pdv.moduleWindows.open({ alias: mod.alias, kernelId });
                }
              }}
              disabled={!kernelId}
              title={mod.name}
            >
              {mod.name.charAt(0).toUpperCase()}
            </button>
          ))}
        </>
      )}
    </div>
    <div className="activity-bar-bottom">
      <button
        className="activity-btn"
        onClick={onOpenTerminal}
        disabled={!kernelId}
        title={
          !kernelId
            ? 'Start a kernel to open a terminal in its working directory'
            : isRemote && remoteHost
              ? `Open terminal on ${remoteHost}`
              : 'Open terminal in working directory'
        }
      >
        <TerminalIcon />
      </button>
      <button
        className="activity-btn"
        onClick={onOpenWorkingDir}
        disabled={!kernelId}
        title={kernelId ? 'Open working directory in editor' : 'Start a kernel to open its working directory'}
      >
        <FolderCodeIcon />
      </button>
      <button
        className="activity-btn"
        onClick={onAgentClick}
        disabled={!kernelId || isRemote}
        title={
          isRemote
            ? "AI agent launch isn't available in remote sessions (PDV's MCP server runs locally)"
            : kernelId
              ? 'Open AI agent in terminal'
              : 'Start a kernel to launch an AI agent'
        }
      >
        <AgentIcon />
      </button>
      <button
        className="activity-btn"
        onClick={onSettingsClick}
        title="Settings"
      >
        <SettingsIcon />
      </button>
    </div>
  </nav>
  );
};
