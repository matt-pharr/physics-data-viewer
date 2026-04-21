import { describe, expect, it } from 'vitest';
import { getActionsForNode } from './ContextMenu';

function actionIds(type: string): string[] {
  const node = { type } as unknown as Parameters<typeof getActionsForNode>[0];
  return getActionsForNode(node).map((action) => action.id);
}

describe('getActionsForNode', () => {
  it('returns script actions for script nodes', () => {
    const ids = actionIds('script');
    expect(ids).toEqual(['run', 'run_defaults', 'edit', 'refresh', 'print', 'copy_path', 'rename', 'delete']);
    expect(ids).not.toContain('create_script');
  });

  it('includes rename for non-root nodes but not for root', () => {
    expect(actionIds('script')).toContain('rename');
    expect(actionIds('folder')).toContain('rename');
    expect(actionIds('mapping')).toContain('rename');
    expect(actionIds('ndarray')).toContain('rename');
    expect(actionIds('root')).not.toContain('rename');
  });

  it('shows type-specific rename label', () => {
    const scriptNode = { type: 'script' } as unknown as Parameters<typeof getActionsForNode>[0];
    const renameAction = getActionsForNode(scriptNode).find((a) => a.id === 'rename');
    expect(renameAction?.label).toBe('Rename script');

    const noteNode = { type: 'markdown' } as unknown as Parameters<typeof getActionsForNode>[0];
    const noteRename = getActionsForNode(noteNode).find((a) => a.id === 'rename');
    expect(noteRename?.label).toBe('Rename note');
  });

  it('returns folder actions including create_node and create_script for folders', () => {
    const ids = actionIds('folder');
    expect(ids).toContain('refresh');
    expect(ids).toContain('create_node');
    expect(ids).toContain('create_script');
    expect(ids).toContain('new_gui');
    expect(ids).not.toContain('view');
  });

  it('returns create_node and create_script for mapping nodes but not ndarray nodes', () => {
    expect(actionIds('mapping')).toContain('create_node');
    expect(actionIds('mapping')).toContain('create_script');
    expect(actionIds('ndarray')).not.toContain('create_node');
    expect(actionIds('ndarray')).not.toContain('create_script');
  });

  it('enables delete action', () => {
    const node = { type: 'script' } as unknown as Parameters<typeof getActionsForNode>[0];
    const deleteAction = getActionsForNode(node).find((action) => action.id === 'delete');
    expect(deleteAction?.disabled).toBe(false);
  });
});
