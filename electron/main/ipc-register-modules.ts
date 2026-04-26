/**
 * ipc-register-modules.ts — Register module-domain IPC handlers.
 *
 * Responsibilities:
 * - Register `window.pdv.modules.*` IPC channels.
 * - Coordinate module install/import/list/settings/action flows.
 * - Manage pending in-memory module state before first project save.
 *
 * Non-responsibilities:
 * - Kernel lifecycle IPC handlers.
 * - App-state/config/theme IPC handlers.
 * - Project save/load/new IPC handlers.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { BrowserWindow, dialog, ipcMain } from "electron";

import { CommRouter } from "./comm-router";
import {
  ImportedModuleDescriptor,
  IPC,
  ModuleActionRequest,
  ModuleActionResult,
  ModuleCreateEmptyRequest,
  ModuleCreateEmptyResult,
  ModuleDescriptor,
  ModuleExportRequest,
  ModuleExportResult,
  ModuleHealthWarning,
  ModuleImportRequest,
  ModuleImportResult,
  ModuleInstallRequest,
  ModuleInstallResult,
  ModuleSettingsRequest,
  ModuleSettingsResult,
  ModuleUninstallResult,
  ModuleUpdateMetadataRequest,
  ModuleUpdateMetadataResult,
  ModuleUpdateResult,
} from "./ipc";
import { KernelManager } from "./kernel-manager";
import { ModuleManager } from "./module-manager";
import {
  bindImportedModule,
  buildModulesSetupPayload,
  buildModuleActionCode,
  isMissingActionScriptError,
  normalizeModuleAlias,
  suggestModuleAlias,
  toPythonArgumentValue,
  toJuliaArgumentValue,
} from "./module-runtime";
import { PDVMessageType } from "./pdv-protocol";
import { ProjectManager, type ProjectModuleImport } from "./project-manager";

type ProjectManifest = Awaited<ReturnType<typeof ProjectManager.readManifest>>;

interface RegisterModulesIpcHandlersOptions {
  win: BrowserWindow;
  kernelManager: KernelManager;
  commRouter: CommRouter;
  moduleManager: ModuleManager;
  kernelWorkingDirs: Map<string, string>;
  readActiveProjectManifest: () => Promise<ProjectManifest | null>;
  getActiveProjectDir: () => string | null;
  getActiveKernelId: () => string | null;
  getPendingModuleImports: () => ProjectModuleImport[];
  getPendingModuleSettings: () => Record<string, Record<string, unknown>>;
  getModuleHealthWarningsByAlias: () => Map<string, ModuleHealthWarning[]>;
  detectPythonVersion: () => Promise<string | undefined>;
  getPdvVersion: () => string;
  runWithProjectManifestWriteLock: <T>(
    projectDir: string,
    task: () => Promise<T>
  ) => Promise<T>;
}

/**
 * Register modules-domain IPC handlers under `IPC.modules.*`.
 *
 * @param options - Dependencies, shared state accessors, and callbacks.
 * @returns Nothing.
 * @throws {Error} Propagates filesystem and module-resolution errors from handlers.
 */
export function registerModulesIpcHandlers(
  options: RegisterModulesIpcHandlersOptions
): void {
  const {
    win,
    kernelManager,
    commRouter,
    moduleManager,
    kernelWorkingDirs,
    readActiveProjectManifest,
    getActiveProjectDir,
    getActiveKernelId,
    getPendingModuleImports,
    getPendingModuleSettings,
    getModuleHealthWarningsByAlias,
    detectPythonVersion,
    getPdvVersion,
    runWithProjectManifestWriteLock,
  } = options;

  ipcMain.handle(
    IPC.modules.listInstalled,
    async (): Promise<ModuleDescriptor[]> => moduleManager.listInstalled()
  );

  ipcMain.handle(
    IPC.modules.install,
    async (_event, request: ModuleInstallRequest): Promise<ModuleInstallResult> =>
      moduleManager.install(request)
  );

  ipcMain.handle(
    IPC.modules.checkUpdates,
    async (_event, moduleId: string): Promise<ModuleUpdateResult> =>
      moduleManager.checkUpdates(moduleId)
  );

  ipcMain.handle(
    IPC.modules.importToProject,
    async (_event, request: ModuleImportRequest): Promise<ModuleImportResult> => {
      const installedModules = await moduleManager.listInstalled();
      const installed = installedModules.find((entry) => entry.id === request.moduleId);
      if (!installed) {
        return {
          success: false,
          status: "error",
          error: `Installed module not found: ${request.moduleId}`,
        };
      }

      const activeManifest = await readActiveProjectManifest();
      const diskModules = activeManifest?.modules ?? [];
      const pendingImports = getPendingModuleImports();
      const allModules = [...diskModules, ...pendingImports];
      const existingAliases = new Set(allModules.map((entry) => entry.alias));
      const baseAlias = normalizeModuleAlias(request.alias ?? installed.id);
      if (existingAliases.has(baseAlias)) {
        return {
          success: false,
          status: "conflict",
          alias: baseAlias,
          suggestedAlias: suggestModuleAlias(baseAlias, existingAliases),
          error: `Module alias already exists: ${baseAlias}`,
        };
      }
      const importedModule: ProjectModuleImport = {
        module_id: installed.id,
        alias: baseAlias,
        version: installed.version,
        revision: installed.revision,
      };

      const activeProjectDir = getActiveProjectDir();
      if (activeProjectDir && activeManifest) {
        const persisted = await runWithProjectManifestWriteLock(
          activeProjectDir,
          async (): Promise<{ success: true } | { success: false; suggestedAlias: string }> => {
            const latestManifest = await ProjectManager.readManifest(activeProjectDir);
            const latestAliases = new Set(latestManifest.modules.map((entry) => entry.alias));
            if (latestAliases.has(baseAlias)) {
              return {
                success: false,
                suggestedAlias: suggestModuleAlias(baseAlias, latestAliases),
              };
            }
            const updatedManifest = {
              ...latestManifest,
              modules: [...latestManifest.modules, importedModule],
              module_settings: latestManifest.module_settings ?? {},
            };
            await ProjectManager.saveManifest(activeProjectDir, updatedManifest);
            return { success: true };
          }
        );
        if (!persisted.success) {
          return {
            success: false,
            status: "conflict",
            alias: baseAlias,
            suggestedAlias: persisted.suggestedAlias,
            error: `Module alias already exists: ${baseAlias}`,
          };
        }

        // Copy module content into the project-local modules directory.
        const moduleInstallPath = installed.installPath
          ?? await moduleManager.getModuleInstallPath(installed.id);
        if (moduleInstallPath) {
          const dest = path.join(activeProjectDir, "modules", installed.id);
          await fs.mkdir(path.join(activeProjectDir, "modules"), { recursive: true });
          // Overwrites any existing copy from a previous import (intentional).
          await fs.cp(moduleInstallPath, dest, { recursive: true });
        }
      } else {
        pendingImports.push(importedModule);
      }

      const pythonVersion = await detectPythonVersion();
      const warnings = await moduleManager.evaluateHealth(importedModule.module_id, {
        pdvVersion: getPdvVersion(),
        pythonVersion,
      });
      getModuleHealthWarningsByAlias().set(baseAlias, warnings);
      const activeKernelId = getActiveKernelId();
      if (activeKernelId && kernelManager.getKernel(activeKernelId)) {
        await bindImportedModule(
          commRouter,
          moduleManager,
          importedModule,
          kernelWorkingDirs.get(activeKernelId),
          activeProjectDir,
        );
        // Send pdv.modules.setup so the kernel walks the newly-registered
        // PDVModule subtree and wires its PDVLib parent dirs into sys.path.
        const setupPayload = await buildModulesSetupPayload(
          moduleManager,
          [importedModule],
          activeProjectDir,
        );
        if (setupPayload.modules.length > 0) {
          await commRouter.request(PDVMessageType.MODULES_SETUP, setupPayload);
        }
      }
      win.webContents.send(IPC.push.treeChanged, {
        changed_paths: [baseAlias],
        change_type: "updated",
      });
      return {
        success: true,
        status: "imported",
        alias: baseAlias,
        warnings,
      };
    }
  );

  ipcMain.handle(
    IPC.modules.createEmpty,
    async (_event, request: ModuleCreateEmptyRequest): Promise<ModuleCreateEmptyResult> => {
      // Normalize and validate the requested id. Collision detection mirrors
      // the importToProject flow: any existing on-disk OR pending module alias
      // blocks creation and the response suggests the next available id.
      let baseAlias: string;
      try {
        baseAlias = normalizeModuleAlias(request.id ?? "");
      } catch (error) {
        return {
          success: false,
          status: "error",
          error: `Invalid module id: ${(error as Error).message}`,
        };
      }

      const activeManifest = await readActiveProjectManifest();
      const diskModules = activeManifest?.modules ?? [];
      const pendingImports = getPendingModuleImports();
      const existingAliases = new Set(
        [...diskModules, ...pendingImports].map((m) => m.alias),
      );
      if (existingAliases.has(baseAlias)) {
        return {
          success: false,
          status: "conflict",
          alias: baseAlias,
          suggestedAlias: suggestModuleAlias(baseAlias, existingAliases),
          error: `Module alias already exists: ${baseAlias}`,
        };
      }

      const activeKernelId = getActiveKernelId();
      if (!activeKernelId || !kernelManager.getKernel(activeKernelId)) {
        return {
          success: false,
          status: "error",
          error: "No running kernel — start one before creating a module.",
        };
      }
      const language =
        request.language ??
        (activeManifest?.language as "python" | "julia" | undefined) ??
        "python";

      try {
        await commRouter.request(PDVMessageType.MODULE_CREATE_EMPTY, {
          id: baseAlias,
          name: request.name || baseAlias,
          version: request.version || "0.1.0",
          description: request.description ?? "",
          language,
        });
      } catch (error) {
        return {
          success: false,
          status: "error",
          error: `Kernel rejected create_empty: ${(error as Error).message}`,
        };
      }

      // Wire sys.path for the fresh module. Symmetric with the import
      // path above: the kernel walks the PDVModule subtree (seeded by
      // MODULE_CREATE_EMPTY) and adds parent dirs of any PDVLib nodes
      // to sys.path. For a freshly created module the subtree has no
      // libs yet, but this call establishes the invariant that every
      // in-session module has been registered with the setup handler,
      // so subsequent tree:createLib hits land in a directory that is
      // already on sys.path.
      const inSessionSetupPayload = await buildModulesSetupPayload(
        moduleManager,
        [
          {
            module_id: baseAlias,
            alias: baseAlias,
            version: request.version || "0.1.0",
            origin: "in_session",
          },
        ],
        getActiveProjectDir(),
      );
      if (inSessionSetupPayload.modules.length > 0) {
        await commRouter.request(PDVMessageType.MODULES_SETUP, inSessionSetupPayload);
      }

      // Record the new module in the pending-imports list so it survives
      // until the first project:save, at which point §3's manifest flush
      // writes it into project.json. Marking origin="in_session" lets the
      // project load path know to read from <saveDir>/modules/<id>/ rather
      // than expecting a global-store install entry.
      pendingImports.push({
        module_id: baseAlias,
        alias: baseAlias,
        version: request.version || "0.1.0",
        origin: "in_session",
      });

      // If a project directory is already set, persist the manifest entry
      // immediately so a mid-session reload (without a project:save) still
      // sees the new module. Match the import handler's write-lock pattern.
      const activeProjectDir = getActiveProjectDir();
      if (activeProjectDir && activeManifest) {
        await runWithProjectManifestWriteLock(activeProjectDir, async () => {
          const latest = await ProjectManager.readManifest(activeProjectDir);
          const latestAliases = new Set(latest.modules.map((m) => m.alias));
          if (latestAliases.has(baseAlias)) {
            return;
          }
          const updated = {
            ...latest,
            modules: [
              ...latest.modules,
              {
                module_id: baseAlias,
                alias: baseAlias,
                version: request.version || "0.1.0",
                origin: "in_session" as const,
              },
            ],
            module_settings: latest.module_settings ?? {},
          };
          await ProjectManager.saveManifest(activeProjectDir, updated);
        });
        // Drop the pending entry now that it's on disk — otherwise §3's
        // pending flush would try to fs.cp an install path that doesn't
        // exist for in-session modules and push a duplicate manifest entry.
        const idx = pendingImports.findIndex((m) => m.alias === baseAlias);
        if (idx >= 0) pendingImports.splice(idx, 1);
      }

      win.webContents.send(IPC.push.treeChanged, {
        changed_paths: [baseAlias],
        change_type: "updated",
      });

      return { success: true, status: "created", alias: baseAlias };
    },
  );

  ipcMain.handle(
    IPC.modules.updateMetadata,
    async (_event, request: ModuleUpdateMetadataRequest): Promise<ModuleUpdateMetadataResult> => {
      if (!request?.alias) {
        return { success: false, error: "alias is required" };
      }
      const activeKernelId = getActiveKernelId();
      if (!activeKernelId || !kernelManager.getKernel(activeKernelId)) {
        return { success: false, error: "No running kernel" };
      }
      try {
        const response = await commRouter.request(PDVMessageType.MODULE_UPDATE, {
          alias: request.alias,
          name: request.name,
          version: request.version,
          description: request.description,
        });
        const payload = response.payload as {
          alias?: string;
          name?: string;
          version?: string;
          description?: string;
        };
        win.webContents.send(IPC.push.treeChanged, {
          changed_paths: [request.alias],
          change_type: "updated",
        });
        return {
          success: true,
          alias: payload.alias,
          name: payload.name,
          version: payload.version,
          description: payload.description,
        };
      } catch (error) {
        return {
          success: false,
          error: `Kernel rejected update: ${(error as Error).message}`,
        };
      }
    },
  );

  ipcMain.handle(
    IPC.modules.exportFromProject,
    async (_event, request: ModuleExportRequest): Promise<ModuleExportResult> => {
      if (!request?.alias) {
        return { success: false, status: "error", error: "alias is required" };
      }
      const activeProjectDir = getActiveProjectDir();
      if (!activeProjectDir) {
        return {
          success: false,
          status: "not_saved",
          error: "Save the project before exporting a module.",
        };
      }
      const manifest = await readActiveProjectManifest();
      const imported = manifest?.modules ?? [];
      const entry = imported.find((m) => m.alias === request.alias);
      if (!entry) {
        return {
          success: false,
          status: "error",
          error: `No imported or in-session module with alias: ${request.alias}`,
        };
      }
      // The project-local module copy at <saveDir>/modules/<module_id>/
      // is always the authoritative source for export: §3's sync step
      // has mirrored edits into it, and §7's manifest writer has
      // stamped pdv-module.json + module-index.json there. For in-session
      // modules (origin="in_session") this path only exists after at
      // least one project:save has completed.
      const srcDir = path.join(activeProjectDir, "modules", entry.module_id);
      try {
        const srcStat = await fs.stat(srcDir);
        if (!srcStat.isDirectory()) {
          return {
            success: false,
            status: "not_saved",
            error: `Module source is not a directory: ${srcDir}`,
          };
        }
      } catch {
        return {
          success: false,
          status: "not_saved",
          error:
            "Module is not present in the project save directory. " +
            "Run File → Save Project before exporting.",
        };
      }

      const destDir = moduleManager.getGlobalStorePath(entry.module_id);
      if (!destDir) {
        return {
          success: false,
          status: "error",
          error: "Could not resolve global store path.",
        };
      }

      // Confirm overwrite for an existing global-store entry — the
      // user might be publishing changes (expected) or blowing away
      // an unrelated module that happens to share the id (not expected
      // but worth a safety check). Skip the prompt when the renderer
      // passes overwrite: true (future scripted flows).
      let destExists = false;
      try {
        await fs.stat(destDir);
        destExists = true;
      } catch {
        // destination doesn't exist yet — fresh publish, no prompt needed.
      }
      if (destExists && !request.overwrite) {
        const confirmResult = await dialog.showMessageBox(win, {
          type: "question",
          buttons: ["Overwrite", "Cancel"],
          defaultId: 0,
          cancelId: 1,
          title: "Overwrite existing module?",
          message: `A module named "${entry.module_id}" already exists in the global store.`,
          detail:
            `Publishing will overwrite ${destDir}. Other projects that ` +
            `import this module will pick up the changes on their next ` +
            `import. Bundled example modules cannot be overwritten here.`,
        });
        if (confirmResult.response !== 0) {
          return { success: false, status: "cancelled" };
        }
      }

      try {
        await fs.mkdir(path.dirname(destDir), { recursive: true });
        await fs.cp(srcDir, destDir, { recursive: true, force: true });
      } catch (error) {
        return {
          success: false,
          status: "error",
          error: `Failed to copy module to global store: ${(error as Error).message}`,
        };
      }

      // Register the freshly-copied directory in the global store
      // index so listInstalled() (and therefore the Import dialog)
      // picks it up immediately. Without this step, fs.cp alone puts
      // the files in place but leaves the index stale, so users can't
      // import what they just exported.
      try {
        await moduleManager.registerInGlobalStore(destDir);
      } catch (error) {
        return {
          success: false,
          status: "error",
          error: `Copied module to ${destDir} but failed to register it: ${(error as Error).message}`,
        };
      }

      // TODO(#182): if pdv-module.json at destDir has an ``upstream`` git
      // URL, offer to commit and push the changes instead of (or in
      // addition to) writing to the global store. Track deletion
      // propagation for that flow as well — see the ENOENT swallow in
      // ipc-register-project.ts's sync step.

      return {
        success: true,
        status: "exported",
        destination: destDir,
      };
    },
  );

  ipcMain.handle(
    IPC.modules.listImported,
    async (): Promise<ImportedModuleDescriptor[]> => {
      if (!getActiveKernelId()) return [];

      let diskModules: ProjectModuleImport[] = [];
      let diskSettings: Record<string, Record<string, unknown>> = {};
      const activeProjectDir = getActiveProjectDir();
      if (activeProjectDir) {
        const manifest = await ProjectManager.readManifest(activeProjectDir);
        diskModules = manifest.modules;
        diskSettings = manifest.module_settings;
      }
      const allModules = [...diskModules, ...getPendingModuleImports()];
      const allSettings = { ...diskSettings, ...getPendingModuleSettings() };

      if (allModules.length === 0) {
        return [];
      }

      const installedModules = await moduleManager.listInstalled();
      const installedById = new Map(installedModules.map((entry) => [entry.id, entry] as const));
      const warningsByAlias = getModuleHealthWarningsByAlias();
      const pythonVersion = await detectPythonVersion();
      return Promise.all(
        allModules.map(async (entry) => {
          let actions: Awaited<ReturnType<ModuleManager["resolveActionScripts"]>>;
          try {
            actions = await moduleManager.resolveActionScripts(entry.module_id, activeProjectDir);
          } catch (error) {
            if (isMissingActionScriptError(error)) {
              actions = [];
            } else {
              throw error;
            }
          }
          const guiInfo = await moduleManager.getModuleGuiInfo(entry.module_id, activeProjectDir);
          return {
            moduleId: entry.module_id,
            name: installedById.get(entry.module_id)?.name ?? entry.module_id,
            alias: entry.alias,
            version: entry.version,
            revision: entry.revision,
            hasGui: guiInfo.hasGui,
            inputs: await moduleManager.getModuleInputs(entry.module_id, activeProjectDir),
            actions: actions.map((action) => ({
              id: action.actionId,
              label: action.actionLabel,
              scriptName: action.name,
              inputIds: action.inputIds,
              ...(action.actionTab ? { tab: action.actionTab } : {}),
            })),
            gui: guiInfo.gui,
            settings: allSettings[entry.alias] ?? {},
            warnings:
              warningsByAlias.get(entry.alias) ??
              (await moduleManager.evaluateHealth(entry.module_id, {
                pdvVersion: getPdvVersion(),
                pythonVersion,
              }, activeProjectDir)),
          };
        })
      );
    }
  );

  ipcMain.handle(
    IPC.modules.saveSettings,
    async (_event, request: ModuleSettingsRequest): Promise<ModuleSettingsResult> => {
      if (!request.values || typeof request.values !== "object" || Array.isArray(request.values)) {
        return {
          success: false,
          error: "Module settings values must be an object",
        };
      }

      const activeManifest = await readActiveProjectManifest();
      const diskModules = activeManifest?.modules ?? [];
      const allModules = [...diskModules, ...getPendingModuleImports()];
      const imported = allModules.find((entry) => entry.alias === request.moduleAlias);
      if (!imported) {
        return {
          success: false,
          error: `Imported module alias not found: ${request.moduleAlias}`,
        };
      }

      const activeProjectDir = getActiveProjectDir();
      if (activeProjectDir && activeManifest) {
        const persisted = await runWithProjectManifestWriteLock(
          activeProjectDir,
          async (): Promise<ModuleSettingsResult> => {
            const latestManifest = await ProjectManager.readManifest(activeProjectDir);
            const hasAlias = latestManifest.modules.some(
              (entry) => entry.alias === request.moduleAlias
            );
            if (!hasAlias) {
              return {
                success: false,
                error: `Imported module alias not found: ${request.moduleAlias}`,
              };
            }
            const updatedManifest = {
              ...latestManifest,
              module_settings: {
                ...latestManifest.module_settings,
                [request.moduleAlias]: request.values,
              },
            };
            await ProjectManager.saveManifest(activeProjectDir, updatedManifest);
            return { success: true };
          }
        );
        return persisted;
      } else {
        getPendingModuleSettings()[request.moduleAlias] = request.values;
      }
      return {
        success: true,
      };
    }
  );

  ipcMain.handle(
    IPC.modules.runAction,
    async (_event, request: ModuleActionRequest): Promise<ModuleActionResult> => {
      if (!kernelManager.getKernel(request.kernelId)) {
        return {
          success: false,
          status: "error",
          error: `Kernel not found: ${request.kernelId}`,
        };
      }

      let diskModules: ProjectModuleImport[] = [];
      const activeProjectDir = getActiveProjectDir();
      if (activeProjectDir) {
        const manifest = await ProjectManager.readManifest(activeProjectDir);
        diskModules = manifest.modules;
      }
      const allModules = [...diskModules, ...getPendingModuleImports()];
      const imported = allModules.find((entry) => entry.alias === request.moduleAlias);
      if (!imported) {
        return {
          success: false,
          status: "error",
          error: `Imported module alias not found: ${request.moduleAlias}`,
        };
      }
      const actions = await moduleManager.resolveActionScripts(imported.module_id, activeProjectDir);
      const action = actions.find((entry) => entry.actionId === request.actionId);
      if (!action) {
        return {
          success: false,
          status: "error",
          error: `Module action not found: ${request.actionId}`,
        };
      }
      const kernel = kernelManager.getKernel(request.kernelId);
      const language = kernel?.language ?? "python";
      const toArgValue = language === "julia" ? toJuliaArgumentValue : toPythonArgumentValue;

      const kwargs: string[] = [];
      if (request.inputValues) {
        const allowedIds = new Set(action.inputIds ?? []);
        for (const [inputId, value] of Object.entries(request.inputValues)) {
          if (allowedIds.size > 0 && !allowedIds.has(inputId)) continue;
          const expression = toArgValue(value);
          if (expression !== null) {
            kwargs.push(`${inputId}=${expression}`);
          }
        }
      }

      const executionCode = buildModuleActionCode(
        request.moduleAlias,
        action.name,
        kwargs,
        language
      );
      return {
        success: true,
        status: "queued",
        executionCode,
      };
    }
  );

  ipcMain.handle(
    IPC.modules.removeImport,
    async (_event, moduleAlias: string): Promise<ModuleSettingsResult> => {
      const pendingImports = getPendingModuleImports();
      const pendingIndex = pendingImports.findIndex((entry) => entry.alias === moduleAlias);
      if (pendingIndex >= 0) {
        pendingImports.splice(pendingIndex, 1);
        delete getPendingModuleSettings()[moduleAlias];
        getModuleHealthWarningsByAlias().delete(moduleAlias);
        return { success: true };
      }

      const activeProjectDir = getActiveProjectDir();
      if (activeProjectDir) {
        const removed = await runWithProjectManifestWriteLock(
          activeProjectDir,
          async (): Promise<boolean> => {
            const manifest = await ProjectManager.readManifest(activeProjectDir);
            const moduleIndex = manifest.modules.findIndex(
              (entry) => entry.alias === moduleAlias
            );
            if (moduleIndex < 0) {
              return false;
            }
            manifest.modules.splice(moduleIndex, 1);
            delete manifest.module_settings[moduleAlias];
            await ProjectManager.saveManifest(activeProjectDir, manifest);
            return true;
          }
        );
        if (removed) {
          getModuleHealthWarningsByAlias().delete(moduleAlias);
          return { success: true };
        }
      }

      return {
        success: false,
        error: `Imported module alias not found: ${moduleAlias}`,
      };
    }
  );

  ipcMain.handle(
    IPC.modules.uninstall,
    async (_event, moduleId: string): Promise<ModuleUninstallResult> =>
      moduleManager.uninstall(moduleId)
  );

  ipcMain.handle(
    IPC.modules.update,
    async (_event, moduleId: string): Promise<ModuleInstallResult> =>
      moduleManager.update(moduleId)
  );
}
