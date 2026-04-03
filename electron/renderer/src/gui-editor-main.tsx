/**
 * gui-editor-main.tsx — React entrypoint for GUI editor popup windows.
 *
 * Boots `<GuiEditorRoot />` into the DOM. This is a secondary Vite
 * entry point loaded by `gui-editor.html`.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { GuiEditorRoot } from './gui-editor/GuiEditorRoot';
import './styles/index.css';
import './styles/gui-editor.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <GuiEditorRoot />
  </React.StrictMode>
);
