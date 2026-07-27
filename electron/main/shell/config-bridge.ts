/**
 * config-bridge.ts — Serves `config:get` / `config:set` by merging the
 * shell-owned and server-owned halves of the config.
 *
 * The renderer's API is unchanged: it still asks for one flat `PDVConfig`
 * and sends one flat patch. This module is the only place that knows the
 * config now lives in two stores — `<userData>/ui-preferences.json` on this
 * machine and `~/.PDV/preferences.json` on whichever host runs the session's
 * server.
 *
 * Responsibilities
 * - Register the `config:*` handlers on ipcMain (they are shell channels now).
 * - `get`: server snapshot with the local half laid over it, so a local key
 *   left behind in an old server file can never shadow the live value.
 * - `set`: partition the patch by owner and fan it out, writing locally and
 *   forwarding the rest over the transport.
 * - Expose {@link readMergedConfig} for shell code that needs the same view
 *   (the launcher handlers read `launchers`, which is now local).
 *
 * What it does NOT do
 * - It does not decide ownership — `local-config-store.ts` owns that table.
 * - It does not touch session keys; those are forwarded verbatim and the
 *   server remains free to shallow-merge `mcp` as it always has.
 *
 * See Also
 * --------
 * shell/local-config-store.ts — the ownership table and shell-side persistence
 * ipc-register-config.ts — the server-side half this forwards to
 */

import { INTERNAL_CHANNELS, IPC, type PDVConfig } from "../ipc";
import { handleIpc } from "../ipc-registry";
import type { LocalConfigStore } from "./local-config-store";
import { partitionConfigUpdates } from "./local-config-store";
import type { ServerHandle } from "./server-supervisor";

/** Dependency bag for {@link registerConfigBridge}. */
export interface RegisterConfigBridgeOptions {
  /** The session's server, holding the session-owned half. */
  server: ServerHandle;
  /** This machine's store, holding the shell-owned half. */
  localConfig: LocalConfigStore;
}

/**
 * Read the merged config exactly as the renderer sees it.
 *
 * @param server - The session's server handle.
 * @param localConfig - This machine's config store.
 * @returns Server config with the shell-owned keys laid over it.
 * @throws {Error} When the server is unreachable.
 */
export async function readMergedConfig(
  server: ServerHandle,
  localConfig: LocalConfigStore
): Promise<PDVConfig> {
  const serverConfig = (await server.invoke(
    INTERNAL_CHANNELS.serverConfigGet
  )) as PDVConfig;
  return { ...serverConfig, ...localConfig.getAll() };
}

/**
 * Register the merging `config:*` handlers.
 *
 * @param options - Dependency bag; see {@link RegisterConfigBridgeOptions}.
 * @returns Nothing.
 */
export function registerConfigBridge(
  options: RegisterConfigBridgeOptions
): void {
  const { server, localConfig } = options;

  handleIpc(IPC.config.get, async () => readMergedConfig(server, localConfig));

  handleIpc(
    IPC.config.set,
    async (_event, updates: Partial<PDVConfig>) => {
      const { local, server: forServer } = partitionConfigUpdates(updates);
      if (Object.keys(local).length > 0) {
        localConfig.apply(local);
      }
      // Always round-trip, even with nothing to forward: the renderer
      // expects `config:set` to answer with the full merged config, and the
      // server half is the only source for its keys.
      const serverConfig = (await server.invoke(
        INTERNAL_CHANNELS.serverConfigSet,
        [forServer]
      )) as PDVConfig;
      return { ...serverConfig, ...localConfig.getAll() };
    }
  );
}
