/**
 * UnsavedChangesDialog — confirmation modal shown before closing/opening
 * when the current session has unsaved changes.
 */

import React from 'react';

interface UnsavedChangesDialogProps {
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export const UnsavedChangesDialog: React.FC<UnsavedChangesDialogProps> = ({
  onSave,
  onDiscard,
  onCancel,
}) => {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="unsaved-changes-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <h3>Unsaved Changes</h3>
        </div>
        <div className="unsaved-changes-body">
          <p>
            Your project has unsaved changes. Would you like to save before
            continuing?
          </p>
        </div>
        <div className="dialog-footer">
          <button className="btn btn-warning" onClick={onDiscard}>
            Don&apos;t Save
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
};
