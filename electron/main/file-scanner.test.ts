import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileScanner } from './file-scanner';

describe('FileScanner', () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-fs-'));
    fs.mkdirSync(path.join(projectDir, 'tree', 'scripts', 'analysis'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'tree', 'data'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'tree', 'results'), { recursive: true });

    fs.writeFileSync(
      path.join(projectDir, 'tree', 'scripts', 'analysis', 'test_script.py'),
      [
        '"""Test script for Physics Data Viewer"""',
        '',
        'def run(tree: dict, param1: int = 10, param2: str = "default"):',
        '    return {"param1": param1, "param2": param2}',
      ].join('\n'),
      'utf-8',
    );
  });

  afterAll(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('scans tree directory and finds script metadata', async () => {
    const scanner = new FileScanner(projectDir);
    const roots = await scanner.scanAll();

    const scriptsNode = roots.find((n) => n.key === 'scripts');
    expect(scriptsNode?.type).toBe('folder');

    const scriptsChildren = await scanner.getChildren('scripts');
    const analysisNode = scriptsChildren.find((n) => n.key === 'analysis');
    expect(analysisNode?.hasChildren).toBe(true);

    const analysisChildren = await scanner.getChildren('scripts.analysis');
    const scriptNode = analysisChildren.find((n) => n.key === 'test_script.py');

    expect(scriptNode?.type).toBe('script');
    expect(scriptNode?.language).toBe('python');
    expect(scriptNode?.preview).toContain('Test script for Physics Data Viewer');
  });
});
