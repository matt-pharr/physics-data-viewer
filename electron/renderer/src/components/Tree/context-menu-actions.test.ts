import { describe, expect, it } from 'vitest';
import { getMenuEntries, type MenuEntry } from './ContextMenu';

type ActionEntry = Extract<MenuEntry, { kind: 'action' }>;

function actions(type: string): ActionEntry[] {
  const node = { type } as unknown as Parameters<typeof getMenuEntries>[0];
  return getMenuEntries(node).filter((e): e is ActionEntry => e.kind === 'action');
}

function actionIds(type: string): string[] {
  return actions(type).map((a) => a.id);
}

describe('getMenuEntries', () => {
  it('returns script actions for script nodes', () => {
    const ids = actionIds('script');
    expect(ids).toEqual([
      'run', 'run_defaults', 'edit',
      'print', 'copy_path', 'rename', 'move', 'duplicate', 'delete',
      'refresh',
    ]);
    expect(ids).not.toContain('create_script');
  });

  it('includes rename, move, and duplicate for non-root nodes but not for root', () => {
    expect(actionIds('script')).toContain('rename');
    expect(actionIds('script')).toContain('move');
    expect(actionIds('script')).toContain('duplicate');
    expect(actionIds('folder')).toContain('rename');
    expect(actionIds('folder')).toContain('move');
    expect(actionIds('folder')).toContain('duplicate');
    expect(actionIds('mapping')).toContain('rename');
    expect(actionIds('ndarray')).toContain('duplicate');
    expect(actionIds('root')).not.toContain('rename');
    expect(actionIds('root')).not.toContain('move');
    expect(actionIds('root')).not.toContain('duplicate');
  });

  it('shows type-specific rename label', () => {
    const renameAction = actions('script').find((a) => a.id === 'rename');
    expect(renameAction?.label).toBe('Rename script');

    const noteRename = actions('markdown').find((a) => a.id === 'rename');
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
    const deleteAction = actions('script').find((a) => a.id === 'delete');
    expect(deleteAction?.disabled).toBe(false);
  });

  // TODO: re-enable after adding file-watcher to detect external edits
  it('includes open for markdown nodes (external editor disabled pending file-watcher)', () => {
    const ids = actionIds('markdown');
    expect(ids).toContain('open_note');
    expect(ids).not.toContain('edit');
  });

  it('includes separators between sections', () => {
    const scriptEntries = getMenuEntries({ type: 'script' } as Parameters<typeof getMenuEntries>[0]);
    expect(scriptEntries.filter((e) => e.kind === 'separator').length).toBe(1);

    const folderEntries = getMenuEntries({ type: 'folder' } as Parameters<typeof getMenuEntries>[0]);
    expect(folderEntries.filter((e) => e.kind === 'separator').length).toBe(2);
  });
});
