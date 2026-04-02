/**
 * gui-viewer-main.tsx — React entrypoint for standalone GUI viewer windows.
 *
 * Boots `<GuiViewerRoot />` into the DOM. This is a secondary Vite
 * entry point loaded by `gui-viewer.html`.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { GuiViewerRoot } from './gui-viewer/GuiViewerRoot';
import './styles/index.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <GuiViewerRoot />
  </React.StrictMode>
);
