/**
 * module-window-main.tsx — React entrypoint for module popup windows.
 *
 * Boots `<ModuleWindowRoot />` into the DOM. This is the secondary Vite
 * entry point loaded by `module-window.html`.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { ModuleWindowRoot } from './module-window/ModuleWindowRoot';
import './styles/index.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ModuleWindowRoot />
  </React.StrictMode>
);
