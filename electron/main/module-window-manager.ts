/**
 * module-window-manager.ts — Manages module GUI popup BrowserWindows.
 *
 * Thin subclass of {@link BaseWindowManager} that supplies the module
 * window's dimensions and renderer entry point. All lifecycle, context
 * lookup, and broadcast logic lives in the base class.
 *
 * Non-responsibilities:
 * - IPC handler registration (see ipc-register-module-windows.ts).
 * - Module manifest validation or action execution.
 */

import { BaseWindowManager, type ChildWindowConfig } from "./base-window-manager";
import type { ModuleWindowContext } from "./ipc";

/** Manages module GUI popup BrowserWindows keyed by module alias. */
export class ModuleWindowManager extends BaseWindowManager<string, ModuleWindowContext> {
  protected buildConfig(alias: string): ChildWindowConfig {
    return {
      htmlFile: "module-window.html",
      windowOptions: {
        width: 500,
        height: 700,
        title: `Module: ${alias}`,
      },
    };
  }

  /**
   * Open a module GUI window for the given alias, or focus it if already
   * open.
   *
   * @param alias - Project-local module alias.
   * @param kernelId - Active kernel ID.
   * @throws {Error} When the window fails to load content.
   */
  async open(alias: string, kernelId: string): Promise<void> {
    await this.openWindowInternal(alias, { alias, kernelId });
  }
}
