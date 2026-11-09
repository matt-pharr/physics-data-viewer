/**
 * Icons.tsx — Named SVG icon components for the activity bar and UI chrome.
 *
 * Each icon is a simple React functional component that passes through
 * standard SVG element props (width, height, className, etc.).
 */

import React from 'react';

type IconProps = React.SVGProps<SVGSVGElement>;

const defaults: IconProps = { width: 20, height: 20, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' };

/** Filled play triangle for execute / run actions. */
export const PlayIcon: React.FC<IconProps> = (props) => (
  <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12" {...props}>
    <path d="M6 4.5v11a0.6 0.6 0 0 0 0.92 0.51l9-5.5a0.6 0.6 0 0 0 0-1.02l-9-5.5A0.6 0.6 0 0 0 6 4.5z" />
  </svg>
);

/** Hierarchical tree / data browser icon. */
export const TreeIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <line x1="4" y1="3" x2="4" y2="17" />
    <line x1="4" y1="6" x2="10" y2="6" />
    <line x1="4" y1="11" x2="10" y2="11" />
    <line x1="4" y1="16" x2="10" y2="16" />
    <rect x="10" y="4" width="6" height="4" rx="1" />
    <rect x="10" y="9" width="6" height="4" rx="1" />
    <rect x="10" y="14" width="6" height="4" rx="1" />
  </svg>
);

/** Curly-brace namespace / variable inspector icon. */
export const NamespaceIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <path d="M7 4C5.5 4 4.5 5 4.5 6.5v2C4.5 10 3.8 10.5 2 11c1.8 0.5 2.5 1 2.5 2.5v2C4.5 17 5.5 16 7 16" />
    <path d="M13 4c1.5 0 2.5 1 2.5 2.5v2C15.5 10 16.2 10.5 18 11c-1.8 0.5-2.5 1-2.5 2.5v2C15.5 17 14.5 16 13 16" />
    <circle cx="10" cy="11" r="1.5" fill="currentColor" stroke="none" />
  </svg>
);

/** Gear / settings icon. */
export const SettingsIcon: React.FC<IconProps> = (props) => (
  <svg viewBox="0 0 20 20" fill="currentColor" width="20" height="20" {...props}>
    <path
      fillRule="evenodd"
      d="
        M10 3.8
        a6.2 6.2 0 1 0 0 12.4
        a6.2 6.2 0 1 0 0-12.4

        M10 7.7
        a2.3 2.3 0 1 1 0 4.6
        a2.3 2.3 0 1 1 0-4.6
      "
    />

    <g transform="translate(10,10)">
      <rect x="-1.2" y="-8" width="2.4" height="3" rx="0.6" />
      <rect x="-1.2" y="-8" width="2.4" height="3" rx="0.6" transform="rotate(45)" />
      <rect x="-1.2" y="-8" width="2.4" height="3" rx="0.6" transform="rotate(90)" />
      <rect x="-1.2" y="-8" width="2.4" height="3" rx="0.6" transform="rotate(135)" />
      <rect x="-1.2" y="-8" width="2.4" height="3" rx="0.6" transform="rotate(180)" />
      <rect x="-1.2" y="-8" width="2.4" height="3" rx="0.6" transform="rotate(225)" />
      <rect x="-1.2" y="-8" width="2.4" height="3" rx="0.6" transform="rotate(270)" />
      <rect x="-1.2" y="-8" width="2.4" height="3" rx="0.6" transform="rotate(315)" />
    </g>
  </svg>
);

/** Robot-head icon for the AI-agent launcher button. */
export const AgentIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <rect x="4" y="7.5" width="12" height="8.5" rx="2" />
    <line x1="10" y1="4" x2="10" y2="7.5" />
    <circle cx="10" cy="3.3" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="8" cy="11.5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12" cy="11.5" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);

/** Terminal-prompt icon for the "open terminal" launcher button. */
export const TerminalIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <rect x="3" y="4" width="14" height="12" rx="1.5" />
    <polyline points="6,8 8.5,10 6,12" />
    <line x1="10.5" y1="12.5" x2="14" y2="12.5" />
  </svg>
);

/** Folder-with-code-caret icon for the "open working directory" button. */
export const FolderCodeIcon: React.FC<IconProps> = (props) => (
  <svg {...defaults} {...props}>
    <path d="M3 6a1 1 0 0 1 1-1h3.5l1.5 2H16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
    <polyline points="8.5,10 7,11.5 8.5,13" />
    <polyline points="11.5,10 13,11.5 11.5,13" />
  </svg>
);
