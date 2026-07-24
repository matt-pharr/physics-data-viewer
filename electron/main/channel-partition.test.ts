/**
 * channel-partition.test.ts — Completeness guard for the shell/server
 * channel partition in `ipc.ts`.
 *
 * Every invoke channel must be owned by exactly one process
 * (SHELL_CHANNELS ∪ SERVER_CHANNELS with no overlap), and every push
 * channel must be classified as shell- or server-originated. A new
 * channel added to `IPC` without a partition assignment fails here, not
 * at runtime when the extracted server can't serve it.
 */

import { describe, expect, it } from "vitest";

import {
  BROADCAST_PUSH_CHANNELS,
  IPC,
  SERVER_CHANNELS,
  SERVER_PUSH_CHANNELS,
  SHELL_CHANNELS,
  SHELL_PUSH_CHANNELS,
} from "./ipc";

/** Every invoke channel: all leaf strings in IPC outside the push namespace. */
function listAllInvokeChannels(): string[] {
  const result: string[] = [];
  for (const [namespace, channels] of Object.entries(IPC)) {
    if (namespace === "push") continue;
    for (const value of Object.values(channels)) {
      if (typeof value === "string") result.push(value);
    }
  }
  return result;
}

describe("shell/server channel partition", () => {
  it("SHELL_CHANNELS and SERVER_CHANNELS exactly partition every invoke channel", () => {
    const all = listAllInvokeChannels();
    const shell = new Set(SHELL_CHANNELS);
    const server = new Set(SERVER_CHANNELS);

    const unassigned = all.filter((c) => !shell.has(c) && !server.has(c));
    expect(unassigned, "channels missing a partition assignment").toEqual([]);

    const doublyAssigned = all.filter((c) => shell.has(c) && server.has(c));
    expect(doublyAssigned, "channels assigned to both processes").toEqual([]);

    const phantomShell = SHELL_CHANNELS.filter((c) => !all.includes(c));
    const phantomServer = SERVER_CHANNELS.filter((c) => !all.includes(c));
    expect(phantomShell, "SHELL_CHANNELS entries not in IPC").toEqual([]);
    expect(phantomServer, "SERVER_CHANNELS entries not in IPC").toEqual([]);
  });

  it("contains no duplicate entries within either set", () => {
    expect(new Set(SHELL_CHANNELS).size).toBe(SHELL_CHANNELS.length);
    expect(new Set(SERVER_CHANNELS).size).toBe(SERVER_CHANNELS.length);
  });

  it("classifies every push channel as shell- or server-originated", () => {
    const allPush = Object.values(IPC.push);
    const classified = new Set([...SERVER_PUSH_CHANNELS, ...SHELL_PUSH_CHANNELS]);

    const unclassified = allPush.filter((c) => !classified.has(c));
    expect(unclassified, "push channels missing a classification").toEqual([]);

    const phantom = [...classified].filter((c) => !(allPush as string[]).includes(c));
    expect(phantom, "classified push channels not in IPC.push").toEqual([]);

    // `menuAction` is the one deliberate dual-origin channel (shell menu +
    // server-forwarded kernel-initiated save/load); everything else has
    // exactly one originating process.
    const dual = (allPush as string[]).filter(
      (c) =>
        (SERVER_PUSH_CHANNELS as string[]).includes(c) &&
        (SHELL_PUSH_CHANNELS as string[]).includes(c),
    );
    expect(dual).toEqual([IPC.push.menuAction]);
  });

  it("broadcast channels are a subset of server-originated pushes", () => {
    const server = new Set(SERVER_PUSH_CHANNELS);
    const outside = BROADCAST_PUSH_CHANNELS.filter((c) => !server.has(c));
    expect(outside).toEqual([]);
  });
});
