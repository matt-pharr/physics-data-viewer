/**
 * preload.ts — Electron preload script.
 *
 * Exposes a minimal, typed ``window.pdv`` API to the renderer process via
 * ``contextBridge.exposeInMainWorld()``. The renderer MUST NOT call
 * ``ipcRenderer`` directly — all IPC goes through this bridge.
 *
 * The bridge surface:
 *
 * ```ts
 * window.pdv = {
 *   // Kernel
 *   execute(code: string): Promise<void>
 *   restartKernel(): Promise<void>
 *
 *   // Tree
 *   treeList(path: string): Promise<NodeDescriptor[]>
 *   treeGet(path: string, mode: string): Promise<unknown>
 *
 *   // Namespace
 *   namespaceQuery(options): Promise<NamespaceSnapshot>
 *
 *   // Project
 *   projectSave(saveDir: string, commandBoxes: unknown[]): Promise<void>
 *   projectLoad(saveDir: string): Promise<unknown[]>
 *   openDirDialog(): Promise<string | null>
 *
 *   // Config
 *   configGet(key: string): Promise<unknown>
 *   configSet(key: string, value: unknown): Promise<void>
 *
 *   // Push subscriptions (renderer → preload → ipcRenderer.on)
 *   onTreeChanged(handler: (payload: unknown) => void): () => void
 *   onProjectLoaded(handler: (payload: unknown) => void): () => void
 *   onKernelStatus(handler: (status: string) => void): () => void
 * }
 * ```
 *
 * See Also
 * --------
 * ARCHITECTURE.md §9 (IPC layer), §11 (renderer ↔ main contract)
 * electron/main/ipc.ts — the other side of these channels
 */

import { contextBridge, ipcRenderer } from "electron";

// ---------------------------------------------------------------------------
// Type declarations (must match ipc.ts channel names)
// ---------------------------------------------------------------------------

// TODO: Add NodeDescriptor and NamespaceSnapshot type imports or inline declarations
// Reference: pdv-protocol.ts

// ---------------------------------------------------------------------------
// Bridge implementation
// ---------------------------------------------------------------------------

contextBridge.exposeInMainWorld("pdv", {
  // TODO: implement in Step 5
  // Stub — replace with real ipcRenderer.invoke() calls
  _notImplemented: () => {
    throw new Error("preload bridge not yet implemented — see IMPLEMENTATION_STEPS.md Step 5");
  },
} satisfies Partial<Window["pdv"]>);

// ---------------------------------------------------------------------------
// Window type augmentation
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    pdv: {
      execute(code: string): Promise<void>;
      restartKernel(): Promise<void>;
      treeList(path: string): Promise<unknown[]>;
      treeGet(path: string, mode: string): Promise<unknown>;
      namespaceQuery(options: {
        includePrivate?: boolean;
        includeModules?: boolean;
        includeCallables?: boolean;
      }): Promise<Record<string, unknown>>;
      projectSave(saveDir: string, commandBoxes: unknown[]): Promise<void>;
      projectLoad(saveDir: string): Promise<unknown[]>;
      openDirDialog(): Promise<string | null>;
      configGet(key: string): Promise<unknown>;
      configSet(key: string, value: unknown): Promise<void>;
      onTreeChanged(handler: (payload: unknown) => void): () => void;
      onProjectLoaded(handler: (payload: unknown) => void): () => void;
      onKernelStatus(handler: (status: string) => void): () => void;
    };
  }
}
