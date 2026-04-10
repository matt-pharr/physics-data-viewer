import { describe, expect, it } from 'vitest';
import { getActionsForNode } from './ContextMenu';

function actionIds(type: string): string[] {
  const node = { type } as unknown as Parameters<typeof getActionsForNode>[0];
  return getActionsForNode(node).map((action) => action.id);
}

describe('getActionsForNode', () => {
  it('returns script actions for script nodes', () => {
    const ids = actionIds('script');
    expect(ids).toEqual(['run', 'run_defaults', 'edit', 'refresh', 'print', 'copy_path', 'delete']);
    expect(ids).not.toContain('create_script');
  });

  it('returns folder actions including create_script for folders', () => {
    const ids = actionIds('folder');
    expect(ids).toContain('refresh');
    expect(ids).toContain('create_script');
    expect(ids).toContain('new_gui');
    expect(ids).not.toContain('view');
  });

  it('returns create_script for mapping nodes but not ndarray nodes', () => {
    expect(actionIds('mapping')).toContain('create_script');
    expect(actionIds('ndarray')).not.toContain('create_script');
  });

  it('enables delete action', () => {
    const node = { type: 'script' } as unknown as Parameters<typeof getActionsForNode>[0];
    const deleteAction = getActionsForNode(node).find((action) => action.id === 'delete');
    expect(deleteAction?.disabled).toBe(false);
  });
});
