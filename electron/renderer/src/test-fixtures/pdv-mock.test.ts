// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";
import type { PDVApi } from "../types/pdv";
import { createPdvMock } from "./pdv-mock";

describe("pdv-mock factory", () => {
  // Note: shape coverage is enforced at compile time by the `satisfies PDVApi`
  // check inside createPdvMock, and the install/window-bind path is exercised
  // by every consumer test. The only thing not statically guaranteed is the
  // runtime override-merge, so that's the one case we keep here.
  it("merges per-namespace overrides without dropping sibling methods", () => {
    const mock = createPdvMock({
      tree: {
        list: vi.fn<PDVApi["tree"]["list"]>(async () => []),
      },
    });
    expect(mock.tree.list).toBeDefined();
    expect(mock.tree.get).toBeDefined();
    expect(mock.tree.createScript).toBeDefined();
  });
});
