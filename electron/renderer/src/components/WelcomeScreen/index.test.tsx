// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WelcomeScreen, type RecentProject } from './index';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderWelcome(overrides: Partial<Parameters<typeof WelcomeScreen>[0]> = {}) {
  const recentProjects: RecentProject[] = overrides.recentProjects ?? [
    { path: '/home/me/project-a', language: 'python', name: 'project-a' },
  ];
  const handlers = {
    onNewProject: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenRecent: vi.fn(),
    onRecoverSession: vi.fn(),
    onDiscardSession: vi.fn(),
    onClearRecents: vi.fn(),
    onConnectHost: vi.fn(),
    onDisconnectHost: vi.fn(),
  };
  render(
    <WelcomeScreen
      recentProjects={recentProjects}
      recoverableSessions={[]}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe('WelcomeScreen — recoverable-session language', () => {
  it('passes the autosave language + env mode to onRecoverSession and shows the badge', async () => {
    const { onRecoverSession } = renderWelcome({
      recoverableSessions: [
        {
          dir: '/tmp/work/julia-session',
          timestamp: new Date().toISOString(),
          language: 'julia',
          envMode: 'pkg',
        },
      ],
    });
    expect(screen.getByText('[Julia]')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Recover' }));
    expect(onRecoverSession).toHaveBeenCalledWith('/tmp/work/julia-session', 'julia', 'pkg');
  });

  it('defaults the badge to Python for pre-sidecar autosaves', () => {
    renderWelcome({
      recentProjects: [],
      recoverableSessions: [
        { dir: '/tmp/work/old-session', timestamp: new Date().toISOString() },
      ],
    });
    expect(screen.getByText('[Python]')).toBeTruthy();
  });
});

describe('WelcomeScreen — Clear recents button (#191)', () => {
  it('renders the Clear button when there are recent projects', () => {
    renderWelcome();
    expect(screen.getByRole('button', { name: 'Clear recent projects list' })).toBeTruthy();
  });

  it('does not render the Clear button when there are no recent projects', () => {
    renderWelcome({ recentProjects: [] });
    expect(screen.queryByRole('button', { name: 'Clear recent projects list' })).toBeNull();
  });

  it('calls onClearRecents after the user confirms', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { onClearRecents } = renderWelcome();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear recent projects list' }));
    expect(onClearRecents).toHaveBeenCalledTimes(1);
  });

  it('does not call onClearRecents when the user cancels the confirm', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { onClearRecents } = renderWelcome();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear recent projects list' }));
    expect(onClearRecents).not.toHaveBeenCalled();
  });
});

describe('WelcomeScreen — remote connect/disconnect button', () => {
  it('is absent entirely when remote mode is gated off', () => {
    renderWelcome();
    expect(screen.queryByRole('button', { name: /Connect to Host/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Disconnect/ })).toBeNull();
  });

  it('offers Connect to Host when no remote session exists', async () => {
    const { onConnectHost } = renderWelcome({ remoteEnabled: true });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Connect to Host…' }));
    expect(onConnectHost).toHaveBeenCalledTimes(1);
  });

  it('flips to Disconnect (naming the host) while the session runs remotely', async () => {
    const { onDisconnectHost, onConnectHost } = renderWelcome({
      remoteEnabled: true,
      remoteHost: 'feyn',
      remoteReachable: true,
    });
    expect(screen.queryByRole('button', { name: 'Connect to Host…' })).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: "Disconnect from ‘feyn’" }));
    expect(onDisconnectHost).toHaveBeenCalledTimes(1);
    expect(onConnectHost).not.toHaveBeenCalled();
  });

  it('offers Reconnect (via the dialog) while the remote session is unreachable', async () => {
    const { onConnectHost, onDisconnectHost } = renderWelcome({
      remoteEnabled: true,
      remoteHost: 'feyn',
      remoteReachable: false,
    });
    expect(screen.queryByRole('button', { name: /Disconnect/ })).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: "Reconnect to ‘feyn’…" }));
    expect(onConnectHost).toHaveBeenCalledTimes(1);
    expect(onDisconnectHost).not.toHaveBeenCalled();
  });
});

describe('WelcomeScreen — recents badges', () => {
  it('shows BOTH language and host for a remote entry that knows its language', () => {
    renderWelcome({
      recentProjects: [
        { path: '/mnt/homes/me/proj', host: 'feyn', language: 'julia', name: 'proj' },
      ],
    });
    expect(screen.getByText('[Julia]')).toBeTruthy();
    expect(screen.getByText('[feyn]')).toBeTruthy();
  });

  it('shows only the host when a legacy remote entry has no recorded language', () => {
    renderWelcome({
      recentProjects: [{ path: '/mnt/homes/me/proj', host: 'feyn', name: 'proj' }],
    });
    expect(screen.getByText('[feyn]')).toBeTruthy();
    // No guessed language badge.
    expect(screen.queryByText('[Python]')).toBeNull();
    expect(screen.queryByText('[Julia]')).toBeNull();
  });
});
