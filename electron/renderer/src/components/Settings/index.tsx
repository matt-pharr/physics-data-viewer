import React, { useState, useEffect } from 'react';
import type { Settings as SettingsType } from '../../../main/ipc';
import './styles.css';

interface SettingsProps {
  onClose: () => void;
}

export const Settings: React.FC<SettingsProps> = ({ onClose }) => {
  const [settings, setSettings] = useState<SettingsType>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [pythonPath, setPythonPath] = useState('');
  const [juliaPath, setJuliaPath] = useState('');
  const [pythonEditor, setPythonEditor] = useState('');
  const [juliaEditor, setJuliaEditor] = useState('');
  const [defaultEditor, setDefaultEditor] = useState('');
  const [treeRoot, setTreeRoot] = useState('');

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const loaded = await window.pdv.settings.get();
      setSettings(loaded);
      
      // Populate form fields
      setPythonPath(loaded.pythonPath || '');
      setJuliaPath(loaded.juliaPath || '');
      setPythonEditor(loaded.editors?.python || '');
      setJuliaEditor(loaded.editors?.julia || '');
      setDefaultEditor(loaded.editors?.default || '');
      setTreeRoot(loaded.treeRoot || '');
      
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);

      const updated: Partial<SettingsType> = {
        pythonPath: pythonPath || undefined,
        juliaPath: juliaPath || undefined,
        treeRoot: treeRoot || undefined,
      };

      // Only include editors if at least one field has a value
      if (pythonEditor || juliaEditor || defaultEditor) {
        updated.editors = {
          python: pythonEditor || undefined,
          julia: juliaEditor || undefined,
          default: defaultEditor || undefined,
        };
      }

      const success = await window.pdv.settings.set(updated);
      if (success) {
        onClose();
      } else {
        setError('Failed to save settings');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleBrowsePython = async () => {
    const result = await window.pdv.files.pickExecutable();
    if (result) {
      setPythonPath(result);
    }
  };

  const handleBrowseJulia = async () => {
    const result = await window.pdv.files.pickExecutable();
    if (result) {
      setJuliaPath(result);
    }
  };

  if (loading) {
    return (
      <div className="settings-overlay">
        <div className="settings-modal">
          <div className="settings-loading">Loading settings...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={onClose} title="Close">
            ×
          </button>
        </div>

        <div className="settings-content">
          {error && <div className="settings-error">{error}</div>}

          <div className="settings-section">
            <h3>Interpreters</h3>
            
            <div className="settings-field">
              <label htmlFor="pythonPath">Python Path</label>
              <div className="settings-field-row">
                <input
                  id="pythonPath"
                  type="text"
                  value={pythonPath}
                  onChange={(e) => setPythonPath(e.target.value)}
                  placeholder="python3"
                />
                <button onClick={handleBrowsePython} className="settings-browse-btn">
                  Browse...
                </button>
              </div>
            </div>

            <div className="settings-field">
              <label htmlFor="juliaPath">Julia Path</label>
              <div className="settings-field-row">
                <input
                  id="juliaPath"
                  type="text"
                  value={juliaPath}
                  onChange={(e) => setJuliaPath(e.target.value)}
                  placeholder="julia"
                />
                <button onClick={handleBrowseJulia} className="settings-browse-btn">
                  Browse...
                </button>
              </div>
            </div>
          </div>

          <div className="settings-section">
            <h3>External Editors</h3>
            
            <div className="settings-field">
              <label htmlFor="pythonEditor">Python Editor Command</label>
              <input
                id="pythonEditor"
                type="text"
                value={pythonEditor}
                onChange={(e) => setPythonEditor(e.target.value)}
                placeholder="code %s"
              />
              <div className="settings-hint">Use %s for the file path</div>
            </div>

            <div className="settings-field">
              <label htmlFor="juliaEditor">Julia Editor Command</label>
              <input
                id="juliaEditor"
                type="text"
                value={juliaEditor}
                onChange={(e) => setJuliaEditor(e.target.value)}
                placeholder="code %s"
              />
              <div className="settings-hint">Use %s for the file path</div>
            </div>

            <div className="settings-field">
              <label htmlFor="defaultEditor">Default Editor Command</label>
              <input
                id="defaultEditor"
                type="text"
                value={defaultEditor}
                onChange={(e) => setDefaultEditor(e.target.value)}
                placeholder="open %s"
              />
              <div className="settings-hint">Use %s for the file path</div>
            </div>
          </div>

          <div className="settings-section">
            <h3>Paths</h3>
            
            <div className="settings-field">
              <label htmlFor="treeRoot">Tree Root Directory</label>
              <input
                id="treeRoot"
                type="text"
                value={treeRoot}
                onChange={(e) => setTreeRoot(e.target.value)}
                placeholder="/tmp/{username}/PDV/tree"
              />
              <div className="settings-hint">Location for data tree storage</div>
            </div>
          </div>
        </div>

        <div className="settings-footer">
          <button onClick={onClose} className="settings-btn-secondary">
            Cancel
          </button>
          <button 
            onClick={handleSave} 
            className="settings-btn-primary"
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};
