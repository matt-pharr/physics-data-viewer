/**
 * project-manager.ts — Coordinates project open/save operations.
 *
 * Handles the multi-step save and load sequences described in
 * ARCHITECTURE.md §8, bridging between the Electron UI, IPC, and the kernel.
 *
 * Save coordination (ARCHITECTURE.md §8.1):
 * 1. App sends ``pdv.project.save`` comm → kernel writes tree + tree-index.json.
 * 2. Kernel responds with checksum.
 * 3. App writes command-boxes.json.
 * 4. App writes project.json (only on full success).
 *
 * Load coordination (ARCHITECTURE.md §8.2):
 * 1. App sends ``pdv.project.load`` comm with save_dir.
 * 2. Kernel reads tree-index.json, populates lazy registry.
 * 3. Kernel pushes ``pdv.project.loaded`` notification.
 * 4. App reads command-boxes.json.
 * 5. UI is unlocked.
 *
 * See Also
 * --------
 * ARCHITECTURE.md §8 (save and load sequences)
 * comm-router.ts — used to send pdv.project.save / pdv.project.load
 */

import { CommRouter } from "./comm-router";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectManifest {
  /** Schema version of project.json. */
  schema_version: string;
  /** ISO 8601 timestamp of last save. */
  saved_at: string;
  /** PDV protocol version used when saving. */
  pdv_version: string;
  /** SHA-256 checksum of tree-index.json. */
  tree_checksum: string;
}

// ---------------------------------------------------------------------------
// ProjectManager
// ---------------------------------------------------------------------------

export class ProjectManager {
  /**
   * @param commRouter - CommRouter connected to the active kernel.
   */
  constructor(private readonly commRouter: CommRouter) {
    // TODO: implement in Step 4
    throw new Error("ProjectManager constructor not yet implemented");
  }

  /**
   * Save the current project to a directory.
   *
   * Implements the full save sequence from ARCHITECTURE.md §8.1.
   *
   * @param saveDir - Absolute path to the project directory.
   * @param commandBoxes - The current command-box state from the renderer.
   */
  async save(saveDir: string, commandBoxes: unknown[]): Promise<void> {
    // TODO: implement in Step 4
    throw new Error("ProjectManager.save not yet implemented");
  }

  /**
   * Load a project from a directory.
   *
   * Implements the full load sequence from ARCHITECTURE.md §8.2.
   * Returns once the ``pdv.project.loaded`` push notification is received.
   *
   * @param saveDir - Absolute path to the project directory.
   * @returns The command-box state read from command-boxes.json.
   */
  async load(saveDir: string): Promise<unknown[]> {
    // TODO: implement in Step 4
    throw new Error("ProjectManager.load not yet implemented");
  }

  /**
   * Read project.json from a directory and return the manifest.
   *
   * Does NOT send any comm messages or interact with the kernel.
   *
   * @param saveDir - Absolute path to the project directory.
   * @throws If project.json is absent or malformed.
   */
  static async readManifest(saveDir: string): Promise<ProjectManifest> {
    // TODO: implement in Step 4
    throw new Error("ProjectManager.readManifest not yet implemented");
  }
}
