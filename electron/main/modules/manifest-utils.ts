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

/**
 * Raw module manifest shape accepted by v1 validation.
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
  inputs?: Array<{
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
  }>;
  actions: Array<{
    id: string;
    label: string;
    script_path: string;
    inputs?: string[];
    tab?: string;
  }>;
  /** Python package name exposed by this module for import. */
  python_package?: string;
  /** Python module to import on kernel start (entry point). */
  entry_point?: string;
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
  if (!Array.isArray(actionsRaw)) {
    throw new Error(`"actions" must be an array in ${manifestPath}`);
  }
  const actions = actionsRaw.map((actionValue, index) => {
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
  const python_package = optionalString(obj, "python_package", manifestPath);
  const entry_point = optionalString(obj, "entry_point", manifestPath);

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
