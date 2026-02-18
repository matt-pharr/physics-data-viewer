import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileScanner } from './file-scanner';

describe('FileScanner', () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-scan-'));
    const analysisDir = path.join(tempDir, 'tree', 'scripts', 'analysis');
    fs.mkdirSync(analysisDir, { recursive: true });
    const scriptPath = path.join(analysisDir, 'test_script.py');
    fs.writeFileSync(
      scriptPath,
      [
        '"""Test script for PDV"""',
        '',
        'def run(tree, param1: int = 5, param2: str = "x"):',
        '    return {"param1": param1, "param2": param2}',
      ].join('\n'),
    );
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('scans tree and extracts script metadata', async () => {
    const scanner = new FileScanner(path.join(tempDir, 'tree'));
    const rootNodes = await scanner.scanAll();

    const scriptsNode = rootNodes.find((n) => n.path === 'scripts');
    expect(scriptsNode).toBeTruthy();

    const scriptsChildren = await scanner.getChildren('scripts');
    const analysisNode = scriptsChildren.find((n) => n.path === 'scripts.analysis');
    expect(analysisNode?.hasChildren).toBe(true);

    const analysisChildren = await scanner.getChildren('scripts.analysis');
    const scriptNode = analysisChildren.find((n) => n.path === 'scripts.analysis.test_script');
    expect(scriptNode?.type).toBe('script');
    expect(scriptNode?.language).toBe('python');
    expect(scriptNode?._file_path).toContain('test_script.py');
    expect(scriptNode?.preview).toBe('Test script for PDV');
  });
});
