/**
 * editor-state.test.ts — Unit tests for the GUI editor reducer.
 *
 * Regression coverage for two data-loss bugs:
 *
 * - DELETE_NODE with the root path ("") used to strip every input/action
 *   descriptor from the manifest while leaving the layout untouched — a
 *   one-keypress corruption (the root row's keyhandler dispatched it).
 * - MOVE_NODE had no "target inside the dragged subtree" guard, so
 *   dropping a container into its own descendant threw inside the
 *   reducer or corrupted the layout.
 */

import { describe, it, expect } from "vitest";
import { editorReducer, getNodeAtPath, type EditorState } from "./editor-state";
import type {
  GuiManifestV1,
  LayoutContainer,
} from "../types/pdv.d";

/**
 * Build a small but realistic editor state:
 *
 * root (column)
 * ├── 0: group "A"
 * │   ├── 0.0: input ref "x"
 * │   └── 0.1: group "B" (empty)
 * └── 1: action ref "go"
 */
function makeState(): EditorState {
  const layout: LayoutContainer = {
    type: "column",
    children: [
      {
        type: "group",
        label: "A",
        children: [
          { type: "input", id: "x" } as never,
          { type: "group", label: "B", children: [] },
        ],
      },
      { type: "action", id: "go" } as never,
    ],
  };
  const manifest: GuiManifestV1 = {
    has_gui: true,
    gui: { layout },
    inputs: [{ id: "x", label: "X value" }],
    actions: [{ id: "go", label: "Run", script_path: "scripts.run" }],
  };
  return {
    manifest,
    selectedNodePath: null,
    dirty: false,
    treePath: "mod.gui",
    kernelId: "k1",
  };
}

describe("DELETE_NODE", () => {
  it("root path is a no-op (regression: used to strip all inputs/actions)", () => {
    const state = makeState();
    const next = editorReducer(state, { type: "DELETE_NODE", path: "" });
    expect(next.manifest.inputs).toHaveLength(1);
    expect(next.manifest.actions).toHaveLength(1);
    expect(next.manifest.gui?.layout.children).toHaveLength(2);
    expect(next.dirty).toBe(false);
  });

  it("deleting a subtree removes its descriptors and layout node", () => {
    const state = makeState();
    const next = editorReducer(state, { type: "DELETE_NODE", path: "0" });
    // Group "A" and the input inside it are gone; the action survives.
    expect(next.manifest.gui?.layout.children).toHaveLength(1);
    expect(next.manifest.inputs).toHaveLength(0);
    expect(next.manifest.actions).toHaveLength(1);
    expect(next.dirty).toBe(true);
  });
});

describe("MOVE_NODE", () => {
  it("rejects moving a container into its own descendant (regression)", () => {
    const state = makeState();
    // Drag group "A" (path 0) into its own child group "B" (path 0.1).
    const next = editorReducer(state, {
      type: "MOVE_NODE",
      fromPath: "0",
      toParentPath: "0.1",
      toIndex: 0,
    });
    // Must be rejected outright: layout unchanged, nothing lost.
    expect(next.manifest.gui?.layout.children).toHaveLength(2);
    expect(getNodeAtPath(next.manifest.gui!.layout, "0.0")).toMatchObject({
      type: "input",
      id: "x",
    });
    expect(getNodeAtPath(next.manifest.gui!.layout, "0.1")).toMatchObject({
      type: "group",
      label: "B",
    });
    expect(next.dirty).toBe(false);
  });

  it("rejects moving a container onto itself", () => {
    const state = makeState();
    const next = editorReducer(state, {
      type: "MOVE_NODE",
      fromPath: "0",
      toParentPath: "0",
      toIndex: 0,
    });
    expect(next.manifest.gui?.layout.children).toHaveLength(2);
    expect(getNodeAtPath(next.manifest.gui!.layout, "0.1")).toMatchObject({
      type: "group",
      label: "B",
    });
  });

  it("does not confuse sibling prefixes (moving node 0 into node 0.1 vs 0.10)", () => {
    // Guard must compare path segments, not string prefixes: "0" is an
    // ancestor of "0.1" but NOT of "01"/"1".
    const state = makeState();
    // Legit move: group "A" (0) into root at index 2 (after the action).
    const next = editorReducer(state, {
      type: "MOVE_NODE",
      fromPath: "0",
      toParentPath: "",
      toIndex: 2,
    });
    const children = next.manifest.gui!.layout.children;
    expect(children).toHaveLength(2);
    expect(children[0]).toMatchObject({ type: "action", id: "go" });
    expect(children[1]).toMatchObject({ type: "group", label: "A" });
    expect(next.dirty).toBe(true);
  });

  it("still allows moving a leaf out of a container", () => {
    const state = makeState();
    // Move input "x" (0.0) to the root at index 0.
    const next = editorReducer(state, {
      type: "MOVE_NODE",
      fromPath: "0.0",
      toParentPath: "",
      toIndex: 0,
    });
    const children = next.manifest.gui!.layout.children;
    expect(children).toHaveLength(3);
    expect(children[0]).toMatchObject({ type: "input", id: "x" });
  });
});
