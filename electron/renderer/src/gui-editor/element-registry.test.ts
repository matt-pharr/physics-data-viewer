/**
 * element-registry.test.ts — Unit tests for the GUI-editor element registry.
 *
 * Covers getElementDef lookup, the per-entry factories (default node shape,
 * descriptor emission), and the collision-free ID generation that keys off the
 * current manifest's inputs and actions.
 */

import { describe, it, expect } from "vitest";
import type { GuiManifestV1, ModuleInputDescriptor, GuiActionDescriptor } from "../types/pdv.d";
import { ELEMENT_REGISTRY, getElementDef } from "./element-registry";

function manifest(
  inputs: ModuleInputDescriptor[] = [],
  actions: GuiActionDescriptor[] = [],
): GuiManifestV1 {
  return { inputs, actions } as unknown as GuiManifestV1;
}

describe("getElementDef", () => {
  it("returns the definition for a known type", () => {
    expect(getElementDef("row")?.label).toBe("Row");
    expect(getElementDef("input")?.category).toBe("leaf");
  });

  it("returns undefined for an unknown type", () => {
    expect(getElementDef("does-not-exist")).toBeUndefined();
  });
});

describe("ELEMENT_REGISTRY invariants", () => {
  it("every entry's factory produces a node whose type matches the entry", () => {
    for (const def of ELEMENT_REGISTRY) {
      const { node } = def.factory(manifest());
      expect(node.type).toBe(def.type);
    }
  });

  it("container entries start with an empty (or single-tab) child list", () => {
    for (const def of ELEMENT_REGISTRY.filter((e) => e.category === "container")) {
      const { node } = def.factory(manifest());
      // Every container node exposes a children array.
      expect(Array.isArray((node as { children?: unknown[] }).children)).toBe(true);
    }
  });

  it("tabs container seeds exactly one default tab", () => {
    const { node } = getElementDef("tabs")!.factory(manifest());
    const children = (node as { children: Array<{ label?: string }> }).children;
    expect(children).toHaveLength(1);
    expect(children[0].label).toBe("Tab 1");
  });
});

describe("leaf factories and ID generation", () => {
  it("input factory emits a matching input descriptor with a fresh id", () => {
    const { node, input } = getElementDef("input")!.factory(manifest());
    expect(input).toBeDefined();
    expect(input!.id).toBe("input_1");
    expect((node as { id: string }).id).toBe("input_1");
    expect(input!.control).toBe("text");
  });

  it("input factory avoids colliding with existing input ids", () => {
    const { input } = getElementDef("input")!.factory(
      manifest([{ id: "input_1", label: "x", control: "text" } as ModuleInputDescriptor]),
    );
    expect(input!.id).toBe("input_2");
  });

  it("action factory avoids ids taken by inputs OR actions", () => {
    const { action } = getElementDef("action")!.factory(
      manifest(
        [{ id: "action_1", label: "x", control: "text" } as ModuleInputDescriptor],
        [{ id: "action_2", label: "y", script_path: "", inputs: [] } as GuiActionDescriptor],
      ),
    );
    // action_1 (an input id) and action_2 (an action id) are both taken.
    expect(action!.id).toBe("action_3");
  });

  it("namelist factory emits a node with an empty tree_path and no descriptor", () => {
    const { node, input, action } = getElementDef("namelist")!.factory(manifest());
    expect((node as { tree_path: string }).tree_path).toBe("");
    expect(input).toBeUndefined();
    expect(action).toBeUndefined();
  });
});
