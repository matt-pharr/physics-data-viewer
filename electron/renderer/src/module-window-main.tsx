/**
 * module-window-main.tsx — React entrypoint for module popup windows.
 *
 * Boots `<ModuleWindowRoot />` into the DOM. This is the secondary Vite
 * entry point loaded by `module-window.html`.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { ModuleWindowRoot } from './module-window/ModuleWindowRoot';
import { queryClient } from './queries/client';
import './styles/index.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ModuleWindowRoot />
    </QueryClientProvider>
  </React.StrictMode>
);
