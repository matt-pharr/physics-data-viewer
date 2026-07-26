/**
 * pick-path.ts — route path picking to the machine the session runs on.
 *
 * Every path PDV asks the user for (project folders, save locations,
 * interpreters, module directories) is interpreted by the *server*, so in a
 * remote session a native dialog would browse the wrong machine entirely.
 * This service is the router: local sessions keep the native dialogs
 * byte-for-byte, remote sessions get the in-app {@link PathPicker} fed by
 * `files.listDir` over the session transport.
 *
 * The picker itself is deliberately minimal — it stands in until the
 * planned command-palette UI replaces it.
 */

import { useStore } from '../store';

/** What kind of path the caller needs. */
export type PickPathMode = 'directory' | 'file' | 'executable';

/** A path-picking request from a call site. */
export interface PickPathRequest {
  mode: PickPathMode;
  /** Dialog heading, e.g. "Choose a project folder". */
  title: string;
  /** Seed path; the session user's home directory when omitted. */
  defaultPath?: string;
}

/** A request in flight, carrying its resolver to the mounted picker. */
export interface ActivePickRequest extends PickPathRequest {
  resolve: (path: string | null) => void;
  /** Monotonic id — keys the picker mount so each request gets fresh state. */
  seq: number;
}

let host: ((req: ActivePickRequest) => void) | null = null;
let nextSeq = 0;

/**
 * Register the mounted PathPicker as the destination for remote picks.
 * Called by App; the returned disposer unregisters on unmount.
 */
export function registerPathPickerHost(
  fn: (req: ActivePickRequest) => void,
): () => void {
  host = fn;
  return () => {
    if (host === fn) host = null;
  };
}

/**
 * Ask the user for a path on the machine the session runs on.
 *
 * @returns The chosen absolute path, or null when cancelled (matching the
 *   native pickers' contract).
 */
export async function pickServerPath(req: PickPathRequest): Promise<string | null> {
  if (useStore.getState().connectionState === 'local') {
    switch (req.mode) {
      case 'directory':
        return window.pdv.files.pickDirectory(req.defaultPath);
      case 'executable':
        return window.pdv.files.pickExecutable();
      default:
        return window.pdv.files.pickFile();
    }
  }
  if (!host) {
    console.error('[pick-path] no PathPicker mounted; cannot pick remotely');
    return null;
  }
  const target = host;
  return new Promise((resolve) => {
    target({ ...req, resolve, seq: nextSeq++ });
  });
}
