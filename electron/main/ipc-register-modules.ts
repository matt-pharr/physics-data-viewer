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

import { BrowserWindow, ipcMain } from "electron";

import { CommRouter } from "./comm-router";
import {
  ImportedModuleDescriptor,
  IPC,
  ModuleActionRequest,
  ModuleActionResult,
  ModuleDescriptor,
  ModuleHealthWarning,
  ModuleImportRequest,
  ModuleImportResult,
  ModuleInstallRequest,
  ModuleInstallResult,
  ModuleSettingsRequest,
  ModuleSettingsResult,
  ModuleUpdateResult,
} from "./ipc";
import { KernelManager } from "./kernel-manager";
import { ModuleManager } from "./module-manager";
import {
  bindImportedModuleScripts,
  isMissingActionScriptError,
  normalizeModuleAlias,
  suggestModuleAlias,
  toPythonArgumentValue,
} from "./module-runtime";
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
        const updatedManifest = {
          ...activeManifest,
          modules: [...activeManifest.modules, importedModule],
          module_settings: activeManifest.module_settings ?? {},
        };
        await ProjectManager.saveManifest(activeProjectDir, updatedManifest);
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
        await bindImportedModuleScripts(
          commRouter,
          moduleManager,
          importedModule,
          kernelWorkingDirs.get(activeKernelId)
        );
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
            actions = await moduleManager.resolveActionScripts(entry.module_id);
          } catch (error) {
            if (isMissingActionScriptError(error)) {
              actions = [];
            } else {
              throw error;
            }
          }
          return {
            moduleId: entry.module_id,
            name: installedById.get(entry.module_id)?.name ?? entry.module_id,
            alias: entry.alias,
            version: entry.version,
            revision: entry.revision,
            inputs: await moduleManager.getModuleInputs(entry.module_id),
            actions: actions.map((action) => ({
              id: action.actionId,
              label: action.actionLabel,
              scriptName: action.name,
              inputIds: action.inputIds,
              ...(action.actionTab ? { tab: action.actionTab } : {}),
            })),
            settings: allSettings[entry.alias] ?? {},
            warnings:
              warningsByAlias.get(entry.alias) ??
              (await moduleManager.evaluateHealth(entry.module_id, {
                pdvVersion: getPdvVersion(),
                pythonVersion,
              })),
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
        const updatedManifest = {
          ...activeManifest,
          module_settings: {
            ...activeManifest.module_settings,
            [request.moduleAlias]: request.values,
          },
        };
        await ProjectManager.saveManifest(activeProjectDir, updatedManifest);
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
      const actions = await moduleManager.resolveActionScripts(imported.module_id);
      const action = actions.find((entry) => entry.actionId === request.actionId);
      if (!action) {
        return {
          success: false,
          status: "error",
          error: `Module action not found: ${request.actionId}`,
        };
      }
      const kwargs: string[] = [];
      if (request.inputValues) {
        const allowedIds = new Set(action.inputIds ?? []);
        for (const [inputId, value] of Object.entries(request.inputValues)) {
          if (allowedIds.size > 0 && !allowedIds.has(inputId)) continue;
          const expression = toPythonArgumentValue(value);
          if (expression !== null) {
            kwargs.push(`${inputId}=${expression}`);
          }
        }
      }

      const invocation = kwargs.length > 0 ? `(${kwargs.join(", ")})` : "()";
      const executionCode = `pdv_tree[${JSON.stringify(
        `${request.moduleAlias}.scripts.${action.name}`
      )}].run${invocation}`;
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
        const manifest = await ProjectManager.readManifest(activeProjectDir);
        const moduleIndex = manifest.modules.findIndex((entry) => entry.alias === moduleAlias);
        if (moduleIndex >= 0) {
          manifest.modules.splice(moduleIndex, 1);
          delete manifest.module_settings[moduleAlias];
          await ProjectManager.saveManifest(activeProjectDir, manifest);
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
}
