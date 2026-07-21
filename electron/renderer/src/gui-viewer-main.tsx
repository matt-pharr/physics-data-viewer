/**
 * gui-viewer-main.tsx — React entrypoint for standalone GUI viewer windows.
 *
 * Boots `<GuiViewerRoot />` into the DOM. This is a secondary Vite
 * entry point loaded by `gui-viewer.html`.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { GuiViewerRoot } from './gui-viewer/GuiViewerRoot';
import { queryClient } from './queries/client';
import './styles/index.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <GuiViewerRoot />
    </QueryClientProvider>
  </React.StrictMode>
);
