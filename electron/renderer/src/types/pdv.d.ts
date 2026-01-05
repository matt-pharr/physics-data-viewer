/**
 * Type declarations for the PDV API exposed via preload.
 * This makes window.pdv fully typed in the renderer.
 */

import type { PDVApi } from '../../../main/ipc';

declare global {
  interface Window {
    pdv: PDVApi;
  }
}

export {};
