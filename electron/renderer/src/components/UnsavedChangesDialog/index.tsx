/**
 * UnsavedChangesDialog — modal that warns the user about unsaved project
 * changes before a destructive action proceeds.
 *
 * Used for window close, app quit, opening another project, changing
 * interpreter, restarting the kernel, and installing app updates. The
 * caller passes the verb describing what's about to happen (e.g. "close
 * PDV", "open another project") and three callbacks for the user's choice.
 *
 * Follows the standard modal-overlay pattern used by SaveAsDialog.
 */

import React, { useEffect, useRef } from 'react';

interface UnsavedChangesDialogProps {
  /** Short verb phrase describing the action that would discard changes. */
  actionLabel: string;
  /** Called when the user picks "Save". Should save and then proceed. */
  onSave: () => void;
  /** Called when the user picks "Don't Save". Should proceed without saving. */
  onDiscard: () => void;
  /** Called when the user picks "Cancel" or dismisses the dialog. */
  onCancel: () => void;
}

export const UnsavedChangesDialog: React.FC<UnsavedChangesDialogProps> = ({
  actionLabel,
  onSave,
  onDiscard,
  onCancel,
}) => {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Focus the safest option (Cancel) by default so an accidental Enter
  // press does not discard the user's work.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="unsaved-changes-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>Unsaved changes</h3>
          <button className="close-btn" onClick={onCancel} aria-label="Close dialog">
            &times;
          </button>
        </div>

        <div className="dialog-body">
          <p className="unsaved-changes-message">
            Your project may have unsaved changes. Save before you {actionLabel}?
          </p>
        </div>

        <div className="dialog-footer">
          <button
            ref={cancelRef}
            className="btn btn-secondary"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button className="btn btn-secondary" onClick={onDiscard}>
            Don&apos;t Save
          </button>
          <button className="btn btn-primary" onClick={onSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
};
