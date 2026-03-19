/**
 * manifest-utils.ts — Module manifest validation and compatibility helpers.
 *
 * Responsibilities:
 * - Validate `pdv-module.json` payloads into typed manifest objects.
 * - Parse and compare semantic versions used by module compatibility checks.
 * - Provide module script-node name sanitization used for tree bindings.
 *
 * Non-responsibilities:
 * - Reading/writing module store index files.
 * - Installing modules from local or Git sources.
 * - Registering IPC handlers.
 */

import type { ModuleInputValue } from "../ipc";

const PYTHON_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Input descriptor type shared between module and GUI manifests. */
export type ModuleInputEntry = {
  id: string;
  label: string;
  type?: string;
  control?: "text" | "dropdown" | "slider" | "checkbox" | "file";
  default?: ModuleInputValue;
  options?: Array<{ label: string; value: ModuleInputValue }>;
  options_tree_path?: string;
  min?: number;
  max?: number;
  step?: number;
  tab?: string;
  section?: string;
  section_collapsed?: boolean;
  tooltip?: string;
  visible_if?: {
    input_id: string;
    equals: ModuleInputValue;
  };
  file_mode?: "file" | "directory";
};

/** Action descriptor type shared between module and GUI manifests. */
export type ModuleActionEntry = {
  id: string;
  label: string;
  script_path: string;
  inputs?: string[];
  tab?: string;
};

/**
 * Raw module manifest shape accepted by v1/v2 validation.
 *
 * Schema v3 modules move inputs/actions/gui to a separate `gui.json` file.
 * Identity fields (id, name, version, compatibility, dependencies) stay here.
 */
export interface ModuleManifestV1 {
  schema_version: string;
  id: string;
  name: string;
  version: string;
  description?: string;
  compatibility?: {
    pdv_min?: string;
    pdv_max?: string;
    python?: string;
    python_min?: string;
    python_max?: string;
  };
  dependencies?: Array<{
    name: string;
    version?: string;
    marker?: string;
  }>;
  /** Scripts list (v3 identity manifest). */
  scripts?: Array<{ name: string; path: string }>;
  /** @deprecated v2 — moved to gui.json in v3. */
  inputs?: ModuleInputEntry[];
  /** @deprecated v2 — moved to gui.json in v3. Required in v2, absent in v3. */
  actions?: ModuleActionEntry[];
  /** @deprecated v2 — moved to gui.json in v3. */
  has_gui?: boolean;
  /** @deprecated v2 — moved to gui.json in v3. */
  gui?: {
    layout: unknown;
  };
  /** File declarations for module-owned files to copy on import. */
  files?: Array<{ name: string; path: string; type: "namelist" | "lib" | "file" }>;
  /** Python package name exposed by this module for import. */
  python_package?: string;
  /** Python module to import on kernel start (entry point). */
  entry_point?: string;
}

/**
 * Standalone GUI manifest (gui.json) for schema v3 modules.
 */
export interface GuiManifestV1 {
  inputs?: ModuleInputEntry[];
  actions: ModuleActionEntry[];
  gui?: { layout: unknown };
  has_gui?: boolean;
}

/**
 * Validate one parsed `pdv-module.json` payload.
 *
 * @param value - Parsed JSON value.
 * @param manifestPath - Manifest path used in error messages.
 * @returns Strongly typed validated manifest.
 * @throws {Error} When required fields are missing or invalid.
 */
export function validateModuleManifest(
  value: unknown,
  manifestPath: string
): ModuleManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid module manifest object: ${manifestPath}`);
  }
  const obj = value as Record<string, unknown>;
  const schemaVersion = requiredString(obj, "schema_version", manifestPath);
  const id = requiredString(obj, "id", manifestPath);
  const name = requiredString(obj, "name", manifestPath);
  const version = requiredString(obj, "version", manifestPath);
  const description = optionalString(obj, "description", manifestPath);
  const compatibility = optionalCompatibility(obj, manifestPath);
  const dependencies = optionalDependencies(obj, manifestPath);
  const inputsRaw = obj.inputs;
  let inputs: ModuleManifestV1["inputs"];
  if (inputsRaw !== undefined) {
    if (!Array.isArray(inputsRaw)) {
      throw new Error(`"inputs" must be an array in ${manifestPath}`);
    }
    inputs = inputsRaw.map((inputValue, index) => {
      if (!inputValue || typeof inputValue !== "object" || Array.isArray(inputValue)) {
        throw new Error(`inputs[${index}] must be an object in ${manifestPath}`);
      }
      const inputObj = inputValue as Record<string, unknown>;
      return {
        id: requiredString(inputObj, "id", manifestPath, `inputs[${index}]`),
        label: requiredString(inputObj, "label", manifestPath, `inputs[${index}]`),
        type: optionalString(inputObj, "type", manifestPath, `inputs[${index}]`),
        control: optionalInputControl(inputObj, manifestPath, `inputs[${index}]`),
        default: optionalPrimitive(inputObj, "default", manifestPath, `inputs[${index}]`),
        options: optionalInputOptions(inputObj, manifestPath, `inputs[${index}]`),
        options_tree_path: optionalString(
          inputObj,
          "options_tree_path",
          manifestPath,
          `inputs[${index}]`
        ),
        min: optionalNumber(inputObj, "min", manifestPath, `inputs[${index}]`),
        max: optionalNumber(inputObj, "max", manifestPath, `inputs[${index}]`),
        step: optionalNumber(inputObj, "step", manifestPath, `inputs[${index}]`),
        tab: optionalString(inputObj, "tab", manifestPath, `inputs[${index}]`),
        section: optionalString(inputObj, "section", manifestPath, `inputs[${index}]`),
        section_collapsed: optionalBoolean(
          inputObj,
          "section_collapsed",
          manifestPath,
          `inputs[${index}]`
        ),
        tooltip: optionalString(inputObj, "tooltip", manifestPath, `inputs[${index}]`),
        visible_if: optionalVisibilityRule(inputObj, manifestPath, `inputs[${index}]`),
        file_mode: optionalFileMode(inputObj, manifestPath, `inputs[${index}]`),
      };
    });
  }

  const actionsRaw = obj.actions;
  // In v3, actions live in gui.json and are absent from pdv-module.json.
  if (schemaVersion === "3") {
    if (actionsRaw !== undefined && !Array.isArray(actionsRaw)) {
      throw new Error(`"actions" must be an array in ${manifestPath}`);
    }
  } else {
    if (!Array.isArray(actionsRaw)) {
      throw new Error(`"actions" must be an array in ${manifestPath}`);
    }
  }
  const actions = (Array.isArray(actionsRaw) ? actionsRaw : []).map((actionValue, index) => {
    if (!actionValue || typeof actionValue !== "object" || Array.isArray(actionValue)) {
      throw new Error(`actions[${index}] must be an object in ${manifestPath}`);
    }
    const actionObj = actionValue as Record<string, unknown>;
    const actionInputsRaw = actionObj.inputs;
    let actionInputs: string[] | undefined;
    if (actionInputsRaw !== undefined) {
      if (!Array.isArray(actionInputsRaw)) {
        throw new Error(`actions[${index}].inputs must be an array of strings in ${manifestPath}`);
      }
      actionInputs = actionInputsRaw.map((inputValue, inputIndex) => {
        if (typeof inputValue !== "string" || inputValue.trim().length === 0) {
          throw new Error(
            `actions[${index}].inputs[${inputIndex}] must be a non-empty string in ${manifestPath}`
          );
        }
        const normalized = inputValue.trim();
        if (!PYTHON_IDENTIFIER_PATTERN.test(normalized)) {
          throw new Error(
            `actions[${index}].inputs[${inputIndex}] must be a valid Python identifier in ${manifestPath}`
          );
        }
        return normalized;
      });
    }
    return {
      id: requiredString(actionObj, "id", manifestPath, `actions[${index}]`),
      label: requiredString(actionObj, "label", manifestPath, `actions[${index}]`),
      script_path: requiredString(
        actionObj,
        "script_path",
        manifestPath,
        `actions[${index}]`
      ),
      inputs: actionInputs,
      tab: optionalString(actionObj, "tab", manifestPath, `actions[${index}]`),
    };
  });
  const has_gui = optionalBoolean(obj, "has_gui", manifestPath);
  const gui = optionalGuiLayout(obj, manifestPath, inputs, actions);
  const python_package = optionalString(obj, "python_package", manifestPath);
  const entry_point = optionalString(obj, "entry_point", manifestPath);

  let files: ModuleManifestV1["files"];
  const filesRaw = obj.files;
  if (filesRaw !== undefined) {
    if (!Array.isArray(filesRaw)) {
      throw new Error(`"files" must be an array in ${manifestPath}`);
    }
    files = filesRaw.map((fileValue, index) => {
      if (!fileValue || typeof fileValue !== "object" || Array.isArray(fileValue)) {
        throw new Error(`files[${index}] must be an object in ${manifestPath}`);
      }
      const fileObj = fileValue as Record<string, unknown>;
      const fileName = requiredString(fileObj, "name", manifestPath, `files[${index}]`);
      const filePath = requiredString(fileObj, "path", manifestPath, `files[${index}]`);
      const fileType = requiredString(fileObj, "type", manifestPath, `files[${index}]`);
      if (fileType !== "namelist" && fileType !== "lib" && fileType !== "file") {
        throw new Error(
          `files[${index}].type must be one of "namelist", "lib", or "file" in ${manifestPath}`
        );
      }
      return { name: fileName, path: filePath, type: fileType as "namelist" | "lib" | "file" };
    });
  }

  return {
    schema_version: schemaVersion,
    id,
    name,
    version,
    description,
    compatibility,
    dependencies,
    inputs,
    actions,
    has_gui,
    gui,
    files,
    python_package,
    entry_point,
  };
}

/**
 * Parse a semantic version string into numeric components.
 *
 * @param version - Version string to parse.
 * @returns Parsed numeric parts, or null when parsing fails.
 */
export function parseSemver(
  version: string
): { major: number; minor: number; patch: number } | null {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)) {
    return null;
  }
  return { major, minor, patch };
}

/**
 * Return true when one version is semantically lower than another.
 *
 * @param left - Left-side version.
 * @param right - Right-side version.
 * @returns True when left < right.
 */
export function isVersionLessThan(left: string, right: string): boolean {
  const compared = compareSemver(left, right);
  return compared !== null && compared < 0;
}

/**
 * Return true when one version is semantically greater than another.
 *
 * @param left - Left-side version.
 * @param right - Right-side version.
 * @returns True when left > right.
 */
export function isVersionGreaterThan(left: string, right: string): boolean {
  const compared = compareSemver(left, right);
  return compared !== null && compared > 0;
}

/**
 * Validate a current Python version against compatibility constraints.
 *
 * Supports simple comparator expressions such as `>=3.10,<3.13`.
 *
 * @param currentVersion - Current Python version string.
 * @param compatibility - Manifest compatibility object.
 * @returns True when all parseable constraints are satisfied.
 */
export function isPythonVersionCompatible(
  currentVersion: string,
  compatibility: {
    python?: string;
    python_min?: string;
    python_max?: string;
  }
): boolean {
  const normalized = extractVersionToken(currentVersion);
  if (!normalized) return false;
  if (compatibility.python) {
    const constraints = compatibility.python
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    for (const constraint of constraints) {
      if (!evaluateSimpleConstraint(normalized, constraint)) {
        return false;
      }
    }
  }
  if (compatibility.python_min && isVersionLessThan(normalized, compatibility.python_min)) {
    return false;
  }
  if (compatibility.python_max && isVersionGreaterThan(normalized, compatibility.python_max)) {
    return false;
  }
  return true;
}

/**
 * Sanitize an action-derived script node name for tree registration.
 *
 * @param value - Candidate script name.
 * @returns Tree-safe script node name.
 */
export function sanitizeScriptNodeName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "script";
  return trimmed.replace(/[./\\\s]+/g, "_");
}

function requiredString(
  obj: Record<string, unknown>,
  key: string,
  filePath: string,
  prefix?: string
): string {
  const raw = obj[key];
  const display = prefix ? `${prefix}.${key}` : key;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`"${display}" must be a non-empty string in ${filePath}`);
  }
  return raw.trim();
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  filePath: string,
  prefix?: string
): string | undefined {
  const raw = obj[key];
  if (raw === undefined) return undefined;
  const display = prefix ? `${prefix}.${key}` : key;
  if (typeof raw !== "string") {
    throw new Error(`"${display}" must be a string in ${filePath}`);
  }
  return raw;
}

function optionalPrimitive(
  obj: Record<string, unknown>,
  key: string,
  filePath: string,
  prefix?: string
): ModuleInputValue | undefined {
  const raw = obj[key];
  if (raw === undefined) return undefined;
  const display = prefix ? `${prefix}.${key}` : key;
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return raw;
  }
  throw new Error(`"${display}" must be a string, number, or boolean in ${filePath}`);
}

function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
  filePath: string,
  prefix?: string
): number | undefined {
  const raw = obj[key];
  if (raw === undefined) return undefined;
  const display = prefix ? `${prefix}.${key}` : key;
  if (typeof raw !== "number" || Number.isNaN(raw)) {
    throw new Error(`"${display}" must be a valid number in ${filePath}`);
  }
  return raw;
}

function optionalBoolean(
  obj: Record<string, unknown>,
  key: string,
  filePath: string,
  prefix?: string
): boolean | undefined {
  const raw = obj[key];
  if (raw === undefined) return undefined;
  const display = prefix ? `${prefix}.${key}` : key;
  if (typeof raw !== "boolean") {
    throw new Error(`"${display}" must be a boolean in ${filePath}`);
  }
  return raw;
}

function optionalInputControl(
  obj: Record<string, unknown>,
  filePath: string,
  prefix?: string
): "text" | "dropdown" | "slider" | "checkbox" | "file" | undefined {
  const value = optionalString(obj, "control", filePath, prefix);
  if (value === undefined) return undefined;
  if (
    value === "text" ||
    value === "dropdown" ||
    value === "slider" ||
    value === "checkbox" ||
    value === "file"
  ) {
    return value;
  }
  const display = prefix ? `${prefix}.control` : "control";
  throw new Error(
    `"${display}" must be one of "text", "dropdown", "slider", "checkbox", or "file" in ${filePath}`
  );
}

function optionalFileMode(
  obj: Record<string, unknown>,
  filePath: string,
  prefix?: string
): "file" | "directory" | undefined {
  const value = optionalString(obj, "file_mode", filePath, prefix);
  if (value === undefined) return undefined;
  if (value === "file" || value === "directory") {
    return value;
  }
  const display = prefix ? `${prefix}.file_mode` : "file_mode";
  throw new Error(`"${display}" must be "file" or "directory" in ${filePath}`);
}

function optionalInputOptions(
  obj: Record<string, unknown>,
  filePath: string,
  prefix?: string
): Array<{ label: string; value: ModuleInputValue }> | undefined {
  const raw = obj.options;
  if (raw === undefined) return undefined;
  const display = prefix ? `${prefix}.options` : "options";
  if (!Array.isArray(raw)) {
    throw new Error(`"${display}" must be an array in ${filePath}`);
  }
  return raw.map((entry, index) => {
    const optionPrefix = `${display}[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`"${optionPrefix}" must be an object in ${filePath}`);
    }
    const option = entry as Record<string, unknown>;
    const value = optionalPrimitive(option, "value", filePath, optionPrefix);
    if (value === undefined) {
      throw new Error(`"${optionPrefix}.value" must be provided in ${filePath}`);
    }
    return {
      label: requiredString(option, "label", filePath, optionPrefix),
      value,
    };
  });
}

function optionalVisibilityRule(
  obj: Record<string, unknown>,
  filePath: string,
  prefix?: string
): { input_id: string; equals: ModuleInputValue } | undefined {
  const raw = obj.visible_if;
  if (raw === undefined) return undefined;
  const display = prefix ? `${prefix}.visible_if` : "visible_if";
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`"${display}" must be an object in ${filePath}`);
  }
  const rule = raw as Record<string, unknown>;
  const equals = optionalPrimitive(rule, "equals", filePath, display);
  if (equals === undefined) {
    throw new Error(`"${display}.equals" must be provided in ${filePath}`);
  }
  return {
    input_id: requiredString(rule, "input_id", filePath, display),
    equals,
  };
}

function optionalCompatibility(
  obj: Record<string, unknown>,
  filePath: string
):
  | {
      pdv_min?: string;
      pdv_max?: string;
      python?: string;
      python_min?: string;
      python_max?: string;
    }
  | undefined {
  const raw = obj.compatibility;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`"compatibility" must be an object in ${filePath}`);
  }
  const compat = raw as Record<string, unknown>;
  return {
    pdv_min: optionalString(compat, "pdv_min", filePath),
    pdv_max: optionalString(compat, "pdv_max", filePath),
    python: optionalString(compat, "python", filePath),
    python_min: optionalString(compat, "python_min", filePath),
    python_max: optionalString(compat, "python_max", filePath),
  };
}

function optionalDependencies(
  obj: Record<string, unknown>,
  filePath: string
): Array<{ name: string; version?: string; marker?: string }> | undefined {
  const raw = obj.dependencies;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`"dependencies" must be an array in ${filePath}`);
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`dependencies[${index}] must be an object in ${filePath}`);
    }
    const dep = entry as Record<string, unknown>;
    return {
      name: requiredString(dep, "name", filePath, `dependencies[${index}]`),
      version: optionalString(dep, "version", filePath),
      marker: optionalString(dep, "marker", filePath),
    };
  });
}

/**
 * Derive the effective `hasGui` flag for a manifest.
 *
 * @param manifest - Validated manifest.
 * @returns True when the module should have a GUI.
 */
export function deriveHasGui(manifest: ModuleManifestV1): boolean {
  if (typeof manifest.has_gui === "boolean") {
    return manifest.has_gui;
  }
  return (manifest.inputs?.length ?? 0) > 0 || (manifest.actions?.length ?? 0) > 0;
}

/**
 * Validate a parsed `gui.json` payload.
 *
 * @param value - Parsed JSON value.
 * @param filePath - File path used in error messages.
 * @returns Strongly typed validated GUI manifest.
 * @throws {Error} When required fields are missing or invalid.
 */
export function validateGuiManifest(
  value: unknown,
  filePath: string
): GuiManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid GUI manifest object: ${filePath}`);
  }
  const obj = value as Record<string, unknown>;

  // Parse inputs (optional)
  const inputsRaw = obj.inputs;
  let inputs: GuiManifestV1["inputs"];
  if (inputsRaw !== undefined) {
    if (!Array.isArray(inputsRaw)) {
      throw new Error(`"inputs" must be an array in ${filePath}`);
    }
    inputs = inputsRaw.map((inputValue, index) => {
      if (!inputValue || typeof inputValue !== "object" || Array.isArray(inputValue)) {
        throw new Error(`inputs[${index}] must be an object in ${filePath}`);
      }
      const inputObj = inputValue as Record<string, unknown>;
      return {
        id: requiredString(inputObj, "id", filePath, `inputs[${index}]`),
        label: requiredString(inputObj, "label", filePath, `inputs[${index}]`),
        type: optionalString(inputObj, "type", filePath, `inputs[${index}]`),
        control: optionalInputControl(inputObj, filePath, `inputs[${index}]`),
        default: optionalPrimitive(inputObj, "default", filePath, `inputs[${index}]`),
        options: optionalInputOptions(inputObj, filePath, `inputs[${index}]`),
        options_tree_path: optionalString(inputObj, "options_tree_path", filePath, `inputs[${index}]`),
        min: optionalNumber(inputObj, "min", filePath, `inputs[${index}]`),
        max: optionalNumber(inputObj, "max", filePath, `inputs[${index}]`),
        step: optionalNumber(inputObj, "step", filePath, `inputs[${index}]`),
        tab: optionalString(inputObj, "tab", filePath, `inputs[${index}]`),
        section: optionalString(inputObj, "section", filePath, `inputs[${index}]`),
        section_collapsed: optionalBoolean(inputObj, "section_collapsed", filePath, `inputs[${index}]`),
        tooltip: optionalString(inputObj, "tooltip", filePath, `inputs[${index}]`),
        visible_if: optionalVisibilityRule(inputObj, filePath, `inputs[${index}]`),
        file_mode: optionalFileMode(inputObj, filePath, `inputs[${index}]`),
      };
    });
  }

  // Parse actions (required)
  const actionsRaw = obj.actions;
  if (!Array.isArray(actionsRaw)) {
    throw new Error(`"actions" must be an array in ${filePath}`);
  }
  const actions = actionsRaw.map((actionValue, index) => {
    if (!actionValue || typeof actionValue !== "object" || Array.isArray(actionValue)) {
      throw new Error(`actions[${index}] must be an object in ${filePath}`);
    }
    const actionObj = actionValue as Record<string, unknown>;
    const actionInputsRaw = actionObj.inputs;
    let actionInputs: string[] | undefined;
    if (actionInputsRaw !== undefined) {
      if (!Array.isArray(actionInputsRaw)) {
        throw new Error(`actions[${index}].inputs must be an array of strings in ${filePath}`);
      }
      actionInputs = actionInputsRaw.map((iv, ii) => {
        if (typeof iv !== "string" || iv.trim().length === 0) {
          throw new Error(`actions[${index}].inputs[${ii}] must be a non-empty string in ${filePath}`);
        }
        const normalized = iv.trim();
        if (!PYTHON_IDENTIFIER_PATTERN.test(normalized)) {
          throw new Error(`actions[${index}].inputs[${ii}] must be a valid Python identifier in ${filePath}`);
        }
        return normalized;
      });
    }
    return {
      id: requiredString(actionObj, "id", filePath, `actions[${index}]`),
      label: requiredString(actionObj, "label", filePath, `actions[${index}]`),
      script_path: requiredString(actionObj, "script_path", filePath, `actions[${index}]`),
      inputs: actionInputs,
      tab: optionalString(actionObj, "tab", filePath, `actions[${index}]`),
    };
  });

  const has_gui = optionalBoolean(obj, "has_gui", filePath);
  const gui = optionalGuiLayout(obj, filePath, inputs, actions);

  return { inputs, actions, gui, has_gui };
}

/**
 * Read and validate `gui.json` from a module directory.
 *
 * @param moduleDir - Directory expected to contain `gui.json`.
 * @returns Validated GUI manifest, or null if absent.
 */
export async function readGuiManifest(
  moduleDir: string
): Promise<GuiManifestV1 | null> {
  const { promises: fs } = await import("fs");
  const path = await import("path");
  const guiPath = path.join(moduleDir, "gui.json");
  let raw: string;
  try {
    raw = await fs.readFile(guiPath, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${guiPath}`);
  }
  return validateGuiManifest(parsed, guiPath);
}

/**
 * Determine whether a module is v3 (split manifest) by schema_version field.
 *
 * @param manifest - Validated module manifest.
 * @returns True when the module uses the v3 split format.
 */
export function isV3Manifest(manifest: ModuleManifestV1): boolean {
  return manifest.schema_version === "3";
}

function optionalGuiLayout(
  obj: Record<string, unknown>,
  filePath: string,
  inputs: ModuleManifestV1["inputs"],
  actions: ModuleManifestV1["actions"]
): ModuleManifestV1["gui"] {
  const raw = obj.gui;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`"gui" must be an object in ${filePath}`);
  }
  const guiObj = raw as Record<string, unknown>;
  const layoutRaw = guiObj.layout;
  if (!layoutRaw || typeof layoutRaw !== "object" || Array.isArray(layoutRaw)) {
    throw new Error(`"gui.layout" must be a container object in ${filePath}`);
  }
  const inputIds = new Set((inputs ?? []).map((i) => i.id));
  const actionIds = new Set((actions ?? []).map((a) => a.id));
  validateLayoutNode(layoutRaw, filePath, "gui.layout", inputIds, actionIds);
  return { layout: layoutRaw };
}

function validateLayoutNode(
  node: unknown,
  filePath: string,
  path: string,
  inputIds: Set<string>,
  actionIds: Set<string>
): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw new Error(`"${path}" must be a layout node object in ${filePath}`);
  }
  const obj = node as Record<string, unknown>;
  const type = obj.type;
  if (typeof type !== "string") {
    throw new Error(`"${path}.type" must be a string in ${filePath}`);
  }
  if (type === "input") {
    const id = obj.id;
    if (typeof id !== "string" || !id.trim()) {
      throw new Error(`"${path}.id" must be a non-empty string in ${filePath}`);
    }
    if (!inputIds.has(id)) {
      throw new Error(`"${path}.id" references unknown input "${id}" in ${filePath}`);
    }
    return;
  }
  if (type === "action") {
    const id = obj.id;
    if (typeof id !== "string" || !id.trim()) {
      throw new Error(`"${path}.id" must be a non-empty string in ${filePath}`);
    }
    if (!actionIds.has(id)) {
      throw new Error(`"${path}.id" references unknown action "${id}" in ${filePath}`);
    }
    return;
  }
  if (type === "namelist") {
    const treePath = obj.tree_path;
    if (typeof treePath !== "string" || !treePath.trim()) {
      throw new Error(`"${path}.tree_path" must be a non-empty string in ${filePath}`);
    }
    if (obj.tree_path_input !== undefined && typeof obj.tree_path_input !== "string") {
      throw new Error(`"${path}.tree_path_input" must be a string in ${filePath}`);
    }
    return;
  }
  const validContainerTypes = ["row", "column", "group", "tabs"];
  if (!validContainerTypes.includes(type)) {
    throw new Error(
      `"${path}.type" must be one of "input", "action", "namelist", "row", "column", "group", or "tabs" in ${filePath}`
    );
  }
  const children = obj.children;
  if (!Array.isArray(children)) {
    throw new Error(`"${path}.children" must be an array in ${filePath}`);
  }
  for (let i = 0; i < children.length; i++) {
    validateLayoutNode(children[i], filePath, `${path}.children[${i}]`, inputIds, actionIds);
  }
}

function compareSemver(left: string, right: string): number | null {
  const l = parseLooseSemver(left);
  const r = parseLooseSemver(right);
  if (!l || !r) return null;
  if (l.major !== r.major) return l.major - r.major;
  if (l.minor !== r.minor) return l.minor - r.minor;
  return l.patch - r.patch;
}

function parseLooseSemver(
  version: string
): { major: number; minor: number; patch: number } | null {
  const strict = parseSemver(version);
  if (strict) return strict;
  const match = version.trim().match(/^(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (Number.isNaN(major) || Number.isNaN(minor)) {
    return null;
  }
  return { major, minor, patch: 0 };
}

function extractVersionToken(value: string): string | null {
  const match = value.match(/(\d+\.\d+(?:\.\d+)?)/);
  if (!match) {
    return null;
  }
  const token = match[1];
  if (token.split(".").length === 2) {
    return `${token}.0`;
  }
  return token;
}

function evaluateSimpleConstraint(current: string, constraint: string): boolean {
  const operators = [">=", "<=", ">", "<", "==", "="] as const;
  const op = operators.find((candidate) => constraint.startsWith(candidate));
  if (!op) {
    return true;
  }
  const rhs = constraint.slice(op.length).trim();
  if (!rhs) return true;
  const normalizedRhs = extractVersionToken(rhs);
  if (!normalizedRhs) return true;
  const compared = compareSemver(current, normalizedRhs);
  if (compared === null) return false;
  switch (op) {
    case ">=":
      return compared >= 0;
    case "<=":
      return compared <= 0;
    case ">":
      return compared > 0;
    case "<":
      return compared < 0;
    case "==":
    case "=":
      return compared === 0;
  }
}
