// @vitest-environment jsdom

/**
 * NamelistField.test.tsx — Renderer tests for the typed namelist fields.
 *
 * Regression coverage for the array field: the displayed text used to be
 * re-derived from the parsed array on every keystroke (split → trim →
 * rejoin), which consumed the comma the user just typed and made arrays
 * effectively uneditable. The field must hold a raw draft while focused
 * and commit the parsed array on blur — like the numeric field already
 * does.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NamelistField } from "./NamelistEditor";

afterEach(() => {
  cleanup();
});

describe("NamelistField (array)", () => {
  it("keeps typed commas and partial entries while editing (regression)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NamelistField value={[]} typeHint="array" onChange={onChange} />);
    const input = screen.getByRole<HTMLInputElement>("textbox");

    await user.click(input);
    await user.keyboard("1, 2,");
    // The raw text — including the trailing comma — must survive.
    expect(input.value).toBe("1, 2,");
    // Nothing committed yet.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("commits the parsed array on blur (numbers stay numeric)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<NamelistField value={[]} typeHint="array" onChange={onChange} />);
    const input = screen.getByRole<HTMLInputElement>("textbox");

    await user.click(input);
    await user.keyboard("1, 2.5, abc");
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([1, 2.5, "abc"]);
  });

  it("displays the committed value when not editing", () => {
    render(
      <NamelistField value={[1, 2, 3]} typeHint="array" onChange={vi.fn()} />
    );
    const input = screen.getByRole<HTMLInputElement>("textbox");
    expect(input.value).toBe("1, 2, 3");
  });

  it("blur without edits does not fire onChange", () => {
    const onChange = vi.fn();
    render(
      <NamelistField value={[1, 2]} typeHint="array" onChange={onChange} />
    );
    fireEvent.blur(screen.getByRole("textbox"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
