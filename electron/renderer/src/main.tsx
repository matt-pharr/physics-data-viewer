/**
 * main.tsx — React renderer entrypoint.
 *
 * Boots the root `<App />` component into the DOM and loads global styles.
 * This file does not contain application business logic.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app';
import './styles/index.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element not found');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
