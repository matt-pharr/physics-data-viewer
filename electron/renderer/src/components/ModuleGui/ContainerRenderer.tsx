/**
 * ContainerRenderer.tsx — Recursive layout renderer for module GUI containers.
 *
 * Renders a LayoutNode tree into React components: rows, columns, groups,
 * tabs, input controls, and action buttons.
 */

import React, { useState } from "react";
import type {
  ImportedModuleActionDescriptor,
  LayoutContainer,
  LayoutNamelistRef,
  LayoutNode,
} from "../../types/pdv";
import type { ModuleInputDescriptor, ModuleInputValue } from "../ModulesPanel/moduleUiHelpers";
import { InputControl } from "./InputControl";
import { ActionButton } from "./ActionButton";
import { NamelistEditor } from "./NamelistEditor";
import "../../styles/module-gui.css";

interface ContainerRendererProps {
  node: LayoutNode;
  moduleAlias: string;
  inputs: ModuleInputDescriptor[];
  actions: ImportedModuleActionDescriptor[];
  inputValues: Record<string, ModuleInputValue>;
  sectionOpen: Record<string, boolean>;
  runningActionKey: string | null;
  kernelReady: boolean;
  kernelId: string | null;
  isInputVisible: (moduleAlias: string, input: ModuleInputDescriptor) => boolean;
  setModuleInputValue: (moduleAlias: string, inputId: string, value: ModuleInputValue) => void;
  persistInputValues: (moduleAlias: string) => Promise<void>;
  setSectionOpenState: (
    moduleAlias: string,
    tabName: string,
    sectionName: string,
    isOpen: boolean
  ) => Promise<void>;
  onRunAction: (actionId: string) => Promise<void>;
  onError: (message: string) => void;
}

export const ContainerRenderer: React.FC<ContainerRendererProps> = (props) => {
  const { node } = props;

  if (node.type === "input") {
    const input = props.inputs.find((i) => i.id === node.id);
    if (!input) return null;
    if (!props.isInputVisible(props.moduleAlias, input)) return null;
    const key = `${props.moduleAlias}:${input.id}`;
    return (
      <InputControl
        moduleAlias={props.moduleAlias}
        input={input}
        value={props.inputValues[key]}
        setModuleInputValue={props.setModuleInputValue}
        persistInputValues={props.persistInputValues}
        onError={props.onError}
      />
    );
  }

  if (node.type === "action") {
    const action = props.actions.find((a) => a.id === node.id);
    if (!action) return null;
    return (
      <ActionButton
        moduleAlias={props.moduleAlias}
        action={action}
        runningActionKey={props.runningActionKey}
        kernelReady={props.kernelReady}
        kernelId={props.kernelId}
        onRunAction={props.onRunAction}
      />
    );
  }

  if (node.type === "namelist") {
    const nml = node as LayoutNamelistRef;
    let resolvedPath = nml.tree_path;
    if (nml.tree_path_input) {
      const key = `${props.moduleAlias}:${nml.tree_path_input}`;
      const override = props.inputValues[key];
      if (typeof override === "string" && override.trim()) {
        resolvedPath = override;
      }
    }
    return (
      <NamelistEditor
        treePath={resolvedPath}
        kernelId={props.kernelId ?? ""}
        moduleAlias={props.moduleAlias}
        treePathInputId={nml.tree_path_input}
        inputValues={props.inputValues}
      />
    );
  }

  const container = node as LayoutContainer;

  if (container.type === "row") {
    return (
      <div className="gui-row">
        {container.children.map((child, i) => (
          <div key={i} className="gui-row-item">
            <ContainerRenderer {...props} node={child} />
          </div>
        ))}
      </div>
    );
  }

  if (container.type === "column") {
    return (
      <div className="gui-column">
        {container.children.map((child, i) => (
          <ContainerRenderer key={i} {...props} node={child} />
        ))}
      </div>
    );
  }

  if (container.type === "group") {
    return (
      <CollapsibleGroup
        label={container.label ?? ""}
        defaultOpen={!container.collapsed}
        moduleAlias={props.moduleAlias}
        sectionOpen={props.sectionOpen}
        setSectionOpenState={props.setSectionOpenState}
      >
        <div className="gui-column">
          {container.children.map((child, i) => (
            <ContainerRenderer key={i} {...props} node={child} />
          ))}
        </div>
      </CollapsibleGroup>
    );
  }

  if (container.type === "tabs") {
    return (
      <TabContainer container={container} {...props} />
    );
  }

  return null;
};

// ---------------------------------------------------------------------------
// Internal sub-components
// ---------------------------------------------------------------------------

interface CollapsibleGroupProps {
  label: string;
  defaultOpen: boolean;
  moduleAlias: string;
  sectionOpen: Record<string, boolean>;
  setSectionOpenState: (
    moduleAlias: string,
    tabName: string,
    sectionName: string,
    isOpen: boolean
  ) => Promise<void>;
  children: React.ReactNode;
}

const CollapsibleGroup: React.FC<CollapsibleGroupProps> = ({
  label,
  defaultOpen,
  moduleAlias,
  sectionOpen,
  setSectionOpenState,
  children,
}) => {
  const stateKey = `gui::${label}`;
  const isOpen = sectionOpen[stateKey] ?? defaultOpen;

  return (
    <details
      className="gui-group"
      open={isOpen}
      onToggle={(e) => {
        void setSectionOpenState(
          moduleAlias,
          "gui",
          label,
          (e.currentTarget as HTMLDetailsElement).open
        ).catch(() => {});
      }}
    >
      <summary className="gui-group-summary">{label}</summary>
      <div className="gui-group-body">{children}</div>
    </details>
  );
};

interface TabContainerProps extends ContainerRendererProps {
  container: LayoutContainer;
}

const TabContainer: React.FC<TabContainerProps> = ({ container, ...rest }) => {
  const tabs = container.children.filter(
    (child): child is LayoutContainer =>
      child.type === "column" || child.type === "group"
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const activeChild = tabs[activeIndex];

  if (tabs.length === 0) return null;

  return (
    <div className="gui-tabs">
      <div className="gui-tabs-header">
        {tabs.map((tab, i) => (
          <button
            key={i}
            className={`gui-tabs-btn ${i === activeIndex ? "active" : ""}`}
            onClick={() => setActiveIndex(i)}
          >
            {tab.label ?? `Tab ${i + 1}`}
          </button>
        ))}
      </div>
      <div className="gui-tabs-content">
        {activeChild && (
          <ContainerRenderer {...rest} node={activeChild} />
        )}
      </div>
    </div>
  );
};
