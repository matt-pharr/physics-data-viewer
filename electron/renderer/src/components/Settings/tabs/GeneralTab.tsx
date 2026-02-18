import React from 'react';

interface GeneralTabProps {
  pythonPath: string;
  juliaPath: string;
  pythonEditor: string;
  juliaEditor: string;
  defaultEditor: string;
  treeRoot: string;
  onPythonPathChange: (value: string) => void;
  onJuliaPathChange: (value: string) => void;
  onPythonEditorChange: (value: string) => void;
  onJuliaEditorChange: (value: string) => void;
  onDefaultEditorChange: (value: string) => void;
  onTreeRootChange: (value: string) => void;
  onBrowsePython: () => void;
  onBrowseJulia: () => void;
}

export const GeneralTab: React.FC<GeneralTabProps> = ({
  pythonPath,
  juliaPath,
  pythonEditor,
  juliaEditor,
  defaultEditor,
  treeRoot,
  onPythonPathChange,
  onJuliaPathChange,
  onPythonEditorChange,
  onJuliaEditorChange,
  onDefaultEditorChange,
  onTreeRootChange,
  onBrowsePython,
  onBrowseJulia,
}) => {
  return (
    <>
      <div className="settings-section">
        <h3>Interpreters</h3>
        
        <div className="settings-field">
          <label htmlFor="pythonPath">Python Path</label>
          <div className="settings-field-row">
            <input
              id="pythonPath"
              type="text"
              value={pythonPath}
              onChange={(e) => onPythonPathChange(e.target.value)}
              placeholder="python3"
            />
            <button onClick={onBrowsePython} className="settings-browse-btn">
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
              onChange={(e) => onJuliaPathChange(e.target.value)}
              placeholder="julia"
            />
            <button onClick={onBrowseJulia} className="settings-browse-btn">
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
            onChange={(e) => onPythonEditorChange(e.target.value)}
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
            onChange={(e) => onJuliaEditorChange(e.target.value)}
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
            onChange={(e) => onDefaultEditorChange(e.target.value)}
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
            onChange={(e) => onTreeRootChange(e.target.value)}
            placeholder="/tmp/{username}/PDV/tree"
          />
          <div className="settings-hint">Location for data tree storage</div>
        </div>
      </div>
    </>
  );
};
