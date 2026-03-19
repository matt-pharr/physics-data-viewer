/**
 * ShortcutCapture — reusable row widget for viewing/recording a single shortcut binding.
 *
 * Purely presentational: all state and callbacks are owned by the parent SettingsDialog.
 */

import React, { useEffect, useState } from 'react';
import { tokenToLabel, buildShortcutString, parseShortcutTokens } from './utils';

export interface ShortcutCaptureProps {
  label: string;
  value: string;
  defaultValue: string;
  conflictsWith: string | null;
  recordingKey: string | null;
  onStartRecording: (key: string) => void;
  onStopRecording: () => void;
  onChange: (v: string) => void;
}

/** Reusable row widget for viewing/recording a single shortcut binding. */
export const ShortcutCapture: React.FC<ShortcutCaptureProps> = ({
  label, value, defaultValue, conflictsWith, recordingKey, onStartRecording, onStopRecording, onChange,
}) => {
  const isRecording = recordingKey === label;
  const [livePreview, setLivePreview] = useState<string[]>([]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on recording stop
    if (!isRecording) { setLivePreview([]); return; }

    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();

      if (e.key === 'Escape') {
        onStopRecording();
        return;
      }

      const combo = buildShortcutString(e);
      const badges = combo ? combo.replace(/\s+/g, '').split('+').filter(Boolean).map(tokenToLabel) : [];
      setLivePreview(badges);

      const isModifierKey = ['Meta', 'Control', 'Shift', 'Alt'].includes(e.key);
      if (!isModifierKey && combo) {
        onChange(combo);
        onStopRecording();
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [isRecording, onChange, onStopRecording]);

  const badges = isRecording ? livePreview : parseShortcutTokens(value);
  const isDefault = value === defaultValue;

  return (
    <>
      <span>{label}</span>
      <div className={`shortcut-keys${conflictsWith ? ' shortcut-conflict' : ''}`} aria-label={`Current shortcut: ${value}`}>
        {isRecording && livePreview.length === 0 ? (
          <span className="shortcut-recording-prompt">Press keys…</span>
        ) : (
          badges.map((badge, i) => (
            <kbd key={i} className="shortcut-key-badge">{badge}</kbd>
          ))
        )}
        {conflictsWith && !isRecording && (
          <span className="shortcut-conflict-warning" title={`Conflicts with "${conflictsWith}"`}>⚠</span>
        )}
      </div>
      <div className="shortcut-actions">
        <button
          type="button"
          className={`btn-sm${isRecording ? ' recording' : ''}`}
          onClick={() => isRecording ? onStopRecording() : onStartRecording(label)}
        >
          {isRecording ? 'Cancel' : 'Set'}
        </button>
        {!isDefault && !isRecording && (
          <button
            type="button"
            className="btn-sm"
            title="Reset to default"
            onClick={() => onChange(defaultValue)}
          >
            ↺
          </button>
        )}
      </div>
    </>
  );
};
