/**
 * useModalKeyboard — shared Enter/Escape handler for modal input fields.
 *
 * Returns a `keyDownHandler` to attach to the modal's primary input. Pressing
 * Enter calls `onSubmit` (with `preventDefault`), and pressing Escape calls
 * `onCancel`. Used by every PDV dialog with a single text input
 * (CreateScriptDialog, CreateNoteDialog, CreateGuiDialog, SaveAsDialog,
 * etc.) to remove the duplicated inline handler.
 */

import type React from 'react';

interface UseModalKeyboardOptions {
  /** Called when the user presses Enter inside the field. */
  onSubmit: () => void;
  /** Called when the user presses Escape inside the field. */
  onCancel: () => void;
}

/**
 * Build a stable `onKeyDown` handler that submits on Enter and cancels on
 * Escape. Both branches call `preventDefault` to suppress browser defaults.
 */
export function useModalKeyboard({
  onSubmit,
  onCancel,
}: UseModalKeyboardOptions): (event: React.KeyboardEvent) => void {
  return (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onSubmit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  };
}
