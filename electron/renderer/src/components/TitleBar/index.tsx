/**
 * TitleBar — Renderer-drawn window chrome for macOS/Linux main window.
 *
 * Renders a theme-aware top bar with optional Linux menu buttons and window
 * controls. Menu dropdown contents remain native and are opened by the main
 * process so existing accelerators and role-based actions keep working.
 */

import React, { useRef, useState } from 'react';
import type { AppMenuTopLevel, WindowChromeInfo } from '../../types';

interface TitleBarProps {
  chromeInfo: WindowChromeInfo;
  menuModel: AppMenuTopLevel[];
  title: string;
}

/** Theme-aware top shell integrated with the Electron main window. */
export const TitleBar: React.FC<TitleBarProps> = ({ chromeInfo, menuModel, title }) => {
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [pendingMenuId, setPendingMenuId] = useState<AppMenuTopLevel['id'] | null>(null);

  const openMenu = async (menuId: AppMenuTopLevel['id']) => {
    const button = buttonRefs.current[menuId];
    if (!button) {
      return;
    }
    const rect = button.getBoundingClientRect();
    setPendingMenuId(menuId);
    try {
      await window.pdv.menu.popup(menuId, rect.left, rect.bottom);
    } finally {
      window.setTimeout(() => setPendingMenuId((current) => (current === menuId ? null : current)), 120);
    }
  };

  return (
    <header
      className={`title-bar title-bar--${chromeInfo.platform}`}
      data-maximized={chromeInfo.isMaximized ? 'true' : 'false'}
    >
      <div className="title-bar-drag-region">
        {chromeInfo.platform === 'macos' && <div className="title-bar-macos-spacer" aria-hidden="true" />}

        {chromeInfo.showMenuBar && (
          <nav className="title-bar-menu" aria-label="Application menu">
            {menuModel.map((menu) => (
              <button
                key={menu.id}
                ref={(node) => { buttonRefs.current[menu.id] = node; }}
                type="button"
                className={`title-bar-menu-button ${pendingMenuId === menu.id ? 'active' : ''}`}
                onClick={() => { void openMenu(menu.id); }}
              >
                {menu.label}
              </button>
            ))}
          </nav>
        )}

        <div className="title-bar-title" title={title}>
          {title}
        </div>

        {chromeInfo.showWindowControls && (
          <div className="title-bar-window-controls">
            <button
              type="button"
              className="title-bar-window-button"
              aria-label="Minimize window"
              onClick={() => { void window.pdv.chrome.minimize(); }}
            >
              <span aria-hidden="true">_</span>
            </button>
            <button
              type="button"
              className="title-bar-window-button"
              aria-label={chromeInfo.isMaximized ? 'Restore window' : 'Maximize window'}
              onClick={() => { void window.pdv.chrome.toggleMaximize(); }}
            >
              <span aria-hidden="true">{chromeInfo.isMaximized ? '[]' : '[ ]'}</span>
            </button>
            <button
              type="button"
              className="title-bar-window-button title-bar-window-button--close"
              aria-label="Close window"
              onClick={() => { void window.pdv.chrome.close(); }}
            >
              <span aria-hidden="true">X</span>
            </button>
          </div>
        )}
      </div>
    </header>
  );
};
