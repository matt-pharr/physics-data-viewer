/**
 * ActivityBar — Vertical icon strip along the left edge of the app.
 *
 * Controls which left sidebar panel is visible (tree, namespace),
 * shows dynamic icons for imported GUI modules, and provides access to settings.
 */

import React from 'react';
import { TreeIcon, NamespaceIcon, SettingsIcon } from '../Icons';

type LeftPanel = 'tree' | 'namespace';

interface ActivityBarProps {
  leftSidebarOpen: boolean;
  leftPanel: LeftPanel;
  onActivityBarClick: (panel: LeftPanel) => void;
  onSettingsClick: () => void;
  guiModules?: { alias: string; name: string }[];
  kernelId: string | null;
}

/** Vertical activity bar with panel toggle buttons, module launchers, and settings. */
export const ActivityBar: React.FC<ActivityBarProps> = ({
  leftSidebarOpen,
  leftPanel,
  onActivityBarClick,
  onSettingsClick,
  guiModules = [],
  kernelId,
}) => (
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
        onClick={onSettingsClick}
        title="Settings"
      >
        <SettingsIcon />
      </button>
    </div>
  </nav>
);
