import { describe, it, expect } from 'vitest';

describe('Project setup', () => {
  it('should have working test infrastructure', () => {
    expect(1 + 1).toBe(2);
  });

  it('should be able to import stub modules', async () => {
    // These should not throw
    await import('./app');
    await import('./index');
    await import('./ipc');
    await import('./kernel-manager');
  });
});
