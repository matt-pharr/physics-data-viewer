/**
 * ActivityBar — Vertical icon strip along the left edge of the app.
 *
 * Controls which sidebar panel is visible (tree, namespace, modules, library)
 * and provides access to settings.
 */

import React from 'react';
import { TreeIcon, NamespaceIcon, ModulesIcon, LibraryIcon, SettingsIcon } from '../Icons';

type LeftPanel = 'tree' | 'namespace';
type RightPanel = 'imported' | 'library';

interface ActivityBarProps {
  leftSidebarOpen: boolean;
  leftPanel: LeftPanel;
  rightSidebarOpen: boolean;
  rightPanel: RightPanel;
  onActivityBarClick: (panel: LeftPanel | RightPanel) => void;
  onSettingsClick: () => void;
}

/** Vertical activity bar with panel toggle buttons and settings. */
export const ActivityBar: React.FC<ActivityBarProps> = ({
  leftSidebarOpen,
  leftPanel,
  rightSidebarOpen,
  rightPanel,
  onActivityBarClick,
  onSettingsClick,
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
      <button
        className={`activity-btn${rightSidebarOpen && rightPanel === 'imported' ? ' active' : ''}`}
        onClick={() => onActivityBarClick('imported')}
        title="Modules"
      >
        <ModulesIcon />
      </button>
      <button
        className={`activity-btn${rightSidebarOpen && rightPanel === 'library' ? ' active' : ''}`}
        onClick={() => onActivityBarClick('library')}
        title="Module Library"
      >
        <LibraryIcon />
      </button>
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
