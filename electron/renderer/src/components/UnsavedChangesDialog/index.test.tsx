// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnsavedChangesDialog } from '.';

afterEach(() => {
  cleanup();
});

describe('UnsavedChangesDialog', () => {
  it('cancels on Escape without triggering save/discard', () => {
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    const onCancel = vi.fn();
    render(
      <UnsavedChangesDialog
        onSave={onSave}
        onDiscard={onDiscard}
        onCancel={onCancel}
      />
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it('wires button actions', () => {
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    const onCancel = vi.fn();
    render(
      <UnsavedChangesDialog
        onSave={onSave}
        onDiscard={onDiscard}
        onCancel={onCancel}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    fireEvent.click(screen.getByRole('button', { name: /Don.t Save/i }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});
