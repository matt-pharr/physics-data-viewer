import type { ImportedModuleDescriptor } from "../../types";

/** Primitive value type accepted by module UI controls. */
export type ModuleInputValue = string | number | boolean;

export type ModuleInputDescriptor = ImportedModuleDescriptor["inputs"][number];
type ModuleActionDescriptor = ImportedModuleDescriptor["actions"][number];

/** Pending import conflict awaiting user decision. */
export interface ImportConflict {
  moduleId: string;
  existingAlias: string;
  suggestedAlias: string;
}

/** Pending install duplicate awaiting user acknowledgement. */
export interface InstallDuplicate {
  moduleName: string;
  status: "up_to_date" | "update_available" | "incompatible_update";
  currentVersion: string;
  currentRevision?: string;
  candidateVersion?: string;
  candidateRevision?: string;
}

export const DEFAULT_MODULE_TAB = "General";
export const ACTIVE_TAB_SETTING_KEY = "__ui_active_tab__";
const SECTION_OPEN_SETTING_PREFIX = "__ui_section_open__:";

/** Build the settings key used for persisted section open/closed state. */
export function sectionSettingKey(tab: string, section: string): string {
  return `${SECTION_OPEN_SETTING_PREFIX}${tab}::${section}`;
}

/** Runtime guard for primitive module input values loaded from settings. */
export function isModuleInputValue(value: unknown): value is ModuleInputValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** Resolve the tab name for one input, defaulting to the General tab. */
export function getInputTabName(input: ModuleInputDescriptor): string {
  return input.tab && input.tab.trim().length > 0 ? input.tab : DEFAULT_MODULE_TAB;
}

/** Resolve the section name for one input, or null when unsectioned. */
export function getInputSectionName(input: ModuleInputDescriptor): string | null {
  if (!input.section) return null;
  const trimmed = input.section.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Resolve the tab name for one action, defaulting to the General tab. */
export function getActionTabName(action: ModuleActionDescriptor): string {
  return action.tab && action.tab.trim().length > 0 ? action.tab : DEFAULT_MODULE_TAB;
}
