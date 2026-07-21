/**
 * gui-editor-main.tsx — React entrypoint for GUI editor popup windows.
 *
 * Boots `<GuiEditorRoot />` into the DOM. This is a secondary Vite
 * entry point loaded by `gui-editor.html`.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { GuiEditorRoot } from './gui-editor/GuiEditorRoot';
import { queryClient } from './queries/client';
import './styles/index.css';
import './styles/gui-editor.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <GuiEditorRoot />
    </QueryClientProvider>
  </React.StrictMode>
);
