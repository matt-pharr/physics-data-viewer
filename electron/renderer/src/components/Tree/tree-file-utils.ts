/** Shared utilities for file-backed tree node dialogs (Move, Duplicate). */

export const FILE_BACKED_TYPES = new Set(['script', 'markdown', 'gui', 'lib', 'namelist']);

export function defaultExtension(type: string): string {
  switch (type) {
    case 'script': return '.py';
    case 'lib': return '.py';
    case 'markdown': return '.md';
    case 'gui': return '.gui.json';
    default: return '';
  }
}
