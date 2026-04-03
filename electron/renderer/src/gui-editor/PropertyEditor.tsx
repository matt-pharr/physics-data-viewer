/**
 * PropertyEditor.tsx — Context-sensitive property form for the selected element.
 *
 * Renders different property fields depending on whether the selected node is
 * a container, input, action, or namelist.
 */

import React from "react";
import type {
  LayoutNode,
  LayoutContainer,
  ModuleInputDescriptor,
  GuiActionDescriptor,
  ModuleInputOptionDescriptor,
} from "../types/pdv.d";
import { useEditorState, useEditorDispatch, getNodeAtPath } from "./editor-state";

function TextProp({
  label,
  value,
  onChange,
  tooltip,
  placeholder,
  warning,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  tooltip?: string;
  placeholder?: string;
  warning?: string;
}) {
  return (
    <div className="gui-editor-prop-group">
      <div className="gui-editor-prop-label" title={tooltip}>{label}</div>
      <input
        className={`gui-editor-prop-input${warning ? " gui-editor-prop-warning" : ""}`}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        title={tooltip}
      />
      {warning && <div className="gui-editor-prop-warning-text">{warning}</div>}
    </div>
  );
}

function NumberProp({
  label,
  value,
  onChange,
  tooltip,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  tooltip?: string;
}) {
  return (
    <div className="gui-editor-prop-group">
      <div className="gui-editor-prop-label" title={tooltip}>{label}</div>
      <input
        className="gui-editor-prop-input"
        type="number"
        value={value ?? ""}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? undefined : Number(v));
        }}
        title={tooltip}
      />
    </div>
  );
}

function CheckboxProp({
  label,
  checked,
  onChange,
  tooltip,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  tooltip?: string;
}) {
  return (
    <div className="gui-editor-prop-group">
      <div className="gui-editor-prop-row" title={tooltip}>
        <input
          className="gui-editor-prop-checkbox"
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <div className="gui-editor-prop-label" style={{ marginBottom: 0 }}>
          {label}
        </div>
      </div>
    </div>
  );
}

function SelectProp({
  label,
  value,
  options,
  onChange,
  tooltip,
}: {
  label: string;
  value: string;
  options: { label: string; value: string }[];
  onChange: (v: string) => void;
  tooltip?: string;
}) {
  return (
    <div className="gui-editor-prop-group">
      <div className="gui-editor-prop-label" title={tooltip}>{label}</div>
      <select
        className="gui-editor-prop-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title={tooltip}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function OptionsEditor({
  options,
  onChange,
}: {
  options: ModuleInputOptionDescriptor[];
  onChange: (opts: ModuleInputOptionDescriptor[]) => void;
}) {
  const addOption = () => {
    onChange([...options, { label: "Option", value: `opt_${options.length + 1}` }]);
  };

  const removeOption = (index: number) => {
    onChange(options.filter((_, i) => i !== index));
  };

  const updateOption = (index: number, field: "label" | "value", val: string) => {
    const updated = options.map((opt, i) =>
      i === index ? { ...opt, [field]: val } : opt
    );
    onChange(updated);
  };

  return (
    <div className="gui-editor-prop-group">
      <div className="gui-editor-prop-label">Options</div>
      <div className="gui-editor-options-list">
        {options.map((opt, i) => (
          <div key={i} className="gui-editor-option-row">
            <input
              value={opt.label}
              onChange={(e) => updateOption(i, "label", e.target.value)}
              placeholder="Label"
            />
            <input
              value={String(opt.value)}
              onChange={(e) => updateOption(i, "value", e.target.value)}
              placeholder="Value"
            />
            <button className="gui-editor-option-remove" onClick={() => removeOption(i)}>
              &times;
            </button>
          </div>
        ))}
        <button className="gui-editor-option-add" onClick={addOption}>
          + Add option
        </button>
      </div>
    </div>
  );
}

function InputBindingsEditor({
  selectedIds,
  allInputs,
  onChange,
}: {
  selectedIds: string[];
  allInputs: ModuleInputDescriptor[];
  onChange: (ids: string[]) => void;
}) {
  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  if (allInputs.length === 0) {
    return (
      <div className="gui-editor-prop-group">
        <div className="gui-editor-prop-label">Input Bindings</div>
        <div style={{ fontSize: 11, color: "var(--text-hint)" }}>No inputs defined</div>
      </div>
    );
  }

  return (
    <div className="gui-editor-prop-group">
      <div className="gui-editor-prop-label">Input Bindings</div>
      <div className="gui-editor-input-bindings">
        {allInputs.map((inp) => (
          <label key={inp.id} className="gui-editor-input-binding">
            <input
              type="checkbox"
              checked={selectedIds.includes(inp.id)}
              onChange={() => toggle(inp.id)}
            />
            {inp.id} ({inp.label})
          </label>
        ))}
      </div>
    </div>
  );
}

// ── Container properties ──

const CONTAINER_TIPS: Record<string, string> = {
  column: "Stacks child elements vertically, one below the other.",
  row: "Arranges child elements horizontally, side by side.",
  group: "A collapsible section with a label header. Use to organize related controls.",
  tabs: "A tabbed container. Each direct child becomes a tab; give children labels to name the tabs.",
};

function ContainerProps({ node, path }: { node: LayoutContainer; path: string }) {
  const dispatch = useEditorDispatch();
  const showCollapsed = node.type === "group";

  return (
    <>
      <div className="gui-editor-properties-header">{node.type} properties</div>
      <div className="gui-editor-prop-hint">{CONTAINER_TIPS[node.type] ?? ""}</div>
      <TextProp
        label="Label"
        value={node.label ?? ""}
        onChange={(v) => dispatch({ type: "UPDATE_NODE", path, updates: { label: v || undefined } })}
        tooltip="Display text shown as the section header (groups) or tab name (tab children)"
        placeholder={node.type === "group" ? "Section name" : node.type === "tabs" ? "Tab container" : "Optional label"}
      />
      {showCollapsed && (
        <CheckboxProp
          label="Initially collapsed"
          checked={node.collapsed ?? false}
          onChange={(v) => dispatch({ type: "UPDATE_NODE", path, updates: { collapsed: v } })}
          tooltip="If checked, this group starts collapsed and the user must click to expand it"
        />
      )}
    </>
  );
}

// ── Input properties ──

function InputProps({ inputId }: { inputId: string }) {
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const input = state.manifest.inputs.find((i) => i.id === inputId);
  if (!input) return <div className="gui-editor-properties-empty">Input not found: {inputId}</div>;

  const update = (updates: Partial<ModuleInputDescriptor>) => {
    dispatch({ type: "UPDATE_INPUT", id: inputId, updates });
  };

  const controlType = input.control ?? "text";

  return (
    <>
      <div className="gui-editor-properties-header">Input properties</div>
      <TextProp
        label="ID" value={input.id} onChange={(v) => update({ id: v })}
        tooltip="Unique identifier used to reference this input in scripts and action bindings"
        placeholder="my_input"
        warning={!input.id.trim() ? "ID is required" : undefined}
      />
      <TextProp
        label="Label" value={input.label} onChange={(v) => update({ label: v })}
        tooltip="Text shown next to the input control in the GUI"
        placeholder="Input Label"
      />
      <SelectProp
        label="Control Type"
        value={controlType}
        options={[
          { label: "Text \u2014 free-form text entry", value: "text" },
          { label: "Dropdown \u2014 pick from a list", value: "dropdown" },
          { label: "Slider \u2014 numeric range", value: "slider" },
          { label: "Checkbox \u2014 true/false toggle", value: "checkbox" },
          { label: "File \u2014 file or directory picker", value: "file" },
        ]}
        onChange={(v) => update({ control: v as ModuleInputDescriptor["control"] })}
        tooltip="How this input is rendered in the GUI"
      />
      <TextProp
        label="Default Value"
        value={input.default != null ? String(input.default) : ""}
        onChange={(v) => update({ default: v })}
        tooltip="Initial value when the GUI opens"
        placeholder="(none)"
      />
      <TextProp
        label="Tooltip"
        value={input.tooltip ?? ""}
        onChange={(v) => update({ tooltip: v || undefined })}
        tooltip="Help text shown when the user hovers over this input in the GUI"
        placeholder="Describe what this input does"
      />
      {controlType === "slider" && (
        <>
          <NumberProp label="Min" value={input.min} onChange={(v) => update({ min: v })} tooltip="Minimum slider value" />
          <NumberProp label="Max" value={input.max} onChange={(v) => update({ max: v })} tooltip="Maximum slider value" />
          <NumberProp label="Step" value={input.step} onChange={(v) => update({ step: v })} tooltip="Slider step increment" />
        </>
      )}
      {controlType === "dropdown" && (
        <>
          <OptionsEditor
            options={input.options ?? []}
            onChange={(opts) => update({ options: opts })}
          />
          <TextProp
            label="Tree Path (dynamic options)"
            value={input.optionsTreePath ?? ""}
            onChange={(v) => update({ optionsTreePath: v || undefined })}
            tooltip="Dot-delimited tree path whose child keys populate the dropdown options dynamically (alternative to static options above)"
            placeholder="e.g. my_module.outputs"
          />
        </>
      )}
      {controlType === "file" && (
        <SelectProp
          label="File Mode"
          value={input.fileMode ?? "file"}
          options={[
            { label: "File", value: "file" },
            { label: "Directory", value: "directory" },
          ]}
          onChange={(v) => update({ fileMode: v as "file" | "directory" })}
          tooltip="Whether the browse button opens a file picker or a directory picker"
        />
      )}
    </>
  );
}

// ── Action properties ──

function ActionProps({ actionId }: { actionId: string }) {
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const action = state.manifest.actions.find((a) => a.id === actionId);
  if (!action) return <div className="gui-editor-properties-empty">Action not found: {actionId}</div>;

  const update = (updates: Partial<GuiActionDescriptor>) => {
    dispatch({ type: "UPDATE_ACTION", id: actionId, updates });
  };

  return (
    <>
      <div className="gui-editor-properties-header">Action properties</div>
      <div className="gui-editor-prop-hint">A button that runs a script when clicked. Bound inputs are passed as keyword arguments.</div>
      <TextProp
        label="ID" value={action.id} onChange={(v) => update({ id: v })}
        tooltip="Unique identifier for this action"
        placeholder="my_action"
        warning={!action.id.trim() ? "ID is required" : undefined}
      />
      <TextProp
        label="Label" value={action.label} onChange={(v) => update({ label: v })}
        tooltip="Button text shown in the GUI"
        placeholder="Run"
      />
      <TextProp
        label="Script Path"
        value={action.script_path}
        onChange={(v) => update({ script_path: v })}
        tooltip="Path to the script relative to this GUI's parent in the tree (e.g. scripts/solve.py)"
        placeholder="scripts/my_script.py"
        warning={!action.script_path.trim() ? "Script path is required \u2014 the button won't work without it" : undefined}
      />
      <InputBindingsEditor
        selectedIds={action.inputs ?? []}
        allInputs={state.manifest.inputs}
        onChange={(ids) => update({ inputs: ids })}
      />
    </>
  );
}

// ── Namelist properties ──

function NamelistProps({ path }: { path: string }) {
  const state = useEditorState();
  const dispatch = useEditorDispatch();
  const node = getNodeAtPath(state.manifest.gui!.layout, path);
  if (!node || node.type !== "namelist") return null;

  return (
    <>
      <div className="gui-editor-properties-header">Namelist properties</div>
      <div className="gui-editor-prop-hint">Renders an inline editor for a namelist file (Fortran .nml/.in or TOML) stored as a tree node.</div>
      <TextProp
        label="Tree Path"
        value={node.tree_path}
        onChange={(v) => dispatch({ type: "UPDATE_NAMELIST", path, updates: { tree_path: v } })}
        tooltip="Dot-delimited path to the PDVNamelist node in the tree (e.g. my_module.inputs.config_file)"
        placeholder="module.inputs.config_file"
        warning={!node.tree_path.trim() ? "Tree path is required \u2014 the namelist editor needs a file to display" : undefined}
      />
      <TextProp
        label="Tree Path Input (optional)"
        value={node.tree_path_input ?? ""}
        onChange={(v) =>
          dispatch({ type: "UPDATE_NAMELIST", path, updates: { tree_path_input: v || undefined } })
        }
        tooltip="ID of a dropdown input whose selected value overrides the tree path. Use to let users switch between multiple namelist files."
        placeholder="(none)"
      />
    </>
  );
}

// ── Main PropertyEditor ──

export function PropertyEditor() {
  const state = useEditorState();
  const { selectedNodePath, manifest } = state;

  if (selectedNodePath === null || !manifest.gui?.layout) {
    return (
      <div className="gui-editor-properties">
        <div className="gui-editor-properties-header">Properties</div>
        <div className="gui-editor-properties-empty">Select an element to edit its properties</div>
      </div>
    );
  }

  const node = getNodeAtPath(manifest.gui.layout, selectedNodePath);
  if (!node) {
    return (
      <div className="gui-editor-properties">
        <div className="gui-editor-properties-header">Properties</div>
        <div className="gui-editor-properties-empty">Node not found</div>
      </div>
    );
  }

  return (
    <div className="gui-editor-properties">
      {node.type === "input" && "id" in node && <InputProps inputId={node.id} />}
      {node.type === "action" && "id" in node && <ActionProps actionId={node.id} />}
      {node.type === "namelist" && <NamelistProps path={selectedNodePath} />}
      {"children" in node && (
        <ContainerProps node={node as LayoutContainer} path={selectedNodePath} />
      )}
    </div>
  );
}
