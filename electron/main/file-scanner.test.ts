import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileScanner } from './file-scanner';

// ─── shared setup ─────────────────────────────────────────────────────────────

let tempDir: string;

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-scan-'));

  // tree/scripts/analysis/test_script.py  (existing test)
  const analysisDir = path.join(tempDir, 'tree', 'scripts', 'analysis');
  fs.mkdirSync(analysisDir, { recursive: true });
  fs.writeFileSync(
    path.join(analysisDir, 'test_script.py'),
    [
      '"""Test script for PDV"""',
      '',
      'def run(tree, param1: int = 5, param2: str = "x"):',
      '    return {"param1": param1, "param2": param2}',
    ].join('\n'),
  );

  // Python script with run() docstring instead of module docstring
  fs.writeFileSync(
    path.join(analysisDir, 'run_doc.py'),
    [
      'def run(tree):',
      '    """Runs the analysis"""',
      '    pass',
    ].join('\n'),
  );

  // Python script with no docstring
  fs.writeFileSync(
    path.join(analysisDir, 'no_doc.py'),
    'def run(tree):\n    pass\n',
  );

  // Julia script with module docstring
  fs.writeFileSync(
    path.join(analysisDir, 'julia_script.jl'),
    '"""Julia analysis module"""\nfunction run(tree)\n  nothing\nend\n',
  );

  // Julia script with run() docstring
  fs.writeFileSync(
    path.join(analysisDir, 'julia_run_doc.jl'),
    '"""Runs the julia analysis"""\nfunction run(tree)\n  nothing\nend\n',
  );

  // tree/data/ — various file types
  const dataDir = path.join(tempDir, 'tree', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'dataset.h5'), '');
  fs.writeFileSync(path.join(dataDir, 'dataset.hdf5'), '');
  fs.writeFileSync(path.join(dataDir, 'data.zarr'), '');
  fs.writeFileSync(path.join(dataDir, 'table.parquet'), '');
  fs.writeFileSync(path.join(dataDir, 'array.npy'), '');
  fs.writeFileSync(path.join(dataDir, 'compressed.npz'), '');
  fs.writeFileSync(path.join(dataDir, 'image.png'), '');
  fs.writeFileSync(path.join(dataDir, 'photo.jpg'), '');
  fs.writeFileSync(path.join(dataDir, 'drawing.svg'), '');
  fs.writeFileSync(path.join(dataDir, 'config.json'), '{}');
  fs.writeFileSync(path.join(dataDir, 'settings.yaml'), '');
  fs.writeFileSync(path.join(dataDir, 'notes.toml'), '');
  fs.writeFileSync(path.join(dataDir, 'readme.txt'), '');
  fs.writeFileSync(path.join(dataDir, 'readme.md'), '');
  fs.writeFileSync(path.join(dataDir, 'unknown.bin'), '');

  // Hidden file in data/
  fs.writeFileSync(path.join(dataDir, '.hidden_file'), '');
  fs.writeFileSync(path.join(tempDir, 'tree', '.hidden_dir_marker'), '');
});

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ─── original test (preserved) ───────────────────────────────────────────────

describe('FileScanner', () => {
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

// ─── scanAll creates default dirs ─────────────────────────────────────────────

describe('FileScanner.scanAll', () => {
  it('creates data/scripts/results subdirs when treeRoot does not exist', async () => {
    const newRoot = path.join(os.tmpdir(), `pdv-new-${Date.now()}`);
    try {
      const scanner = new FileScanner(newRoot);
      await scanner.scanAll();
      expect(fs.existsSync(path.join(newRoot, 'data'))).toBe(true);
      expect(fs.existsSync(path.join(newRoot, 'scripts'))).toBe(true);
      expect(fs.existsSync(path.join(newRoot, 'results'))).toBe(true);
    } finally {
      fs.rmSync(newRoot, { recursive: true, force: true });
    }
  });
});

// ─── hidden file filtering ────────────────────────────────────────────────────

describe('FileScanner hidden files', () => {
  it('excludes hidden files by default (includeHidden: false)', async () => {
    const scanner = new FileScanner(path.join(tempDir, 'tree'));
    const dataChildren = await scanner.getChildren('data');
    const names = dataChildren.map((n) => n.key);
    expect(names.some((n) => n.startsWith('.'))).toBe(false);
  });

  it('includes hidden files when includeHidden: true', async () => {
    const scanner = new FileScanner(path.join(tempDir, 'tree'), { includeHidden: true });
    const dataChildren = await scanner.getChildren('data');
    const names = dataChildren.map((n) => n.key);
    expect(names.some((n) => n.startsWith('.'))).toBe(true);
  });
});

// ─── file type detection ──────────────────────────────────────────────────────

describe('FileScanner file type detection', () => {
  let nodes: Awaited<ReturnType<FileScanner['getChildren']>>;

  beforeAll(async () => {
    const scanner = new FileScanner(path.join(tempDir, 'tree'));
    nodes = await scanner.getChildren('data');
  });

  const assertType = (filename: string, expectedType: string, extra?: Record<string, unknown>) => {
    it(`classifies ${filename} as ${expectedType}`, () => {
      const node = nodes.find((n) => n.key === filename || n.key === path.basename(filename));
      expect(node).toBeTruthy();
      expect(node?.type).toBe(expectedType);
      if (extra) {
        for (const [k, v] of Object.entries(extra)) {
          expect((node as any)[k]).toBe(v);
        }
      }
    });
  };

  assertType('dataset.h5', 'hdf5', { loaderHint: 'hdf5' });
  assertType('dataset.hdf5', 'hdf5', { loaderHint: 'hdf5' });
  assertType('data.zarr', 'zarr', { loaderHint: 'zarr' });
  assertType('table.parquet', 'parquet', { loaderHint: 'parquet' });
  assertType('array.npy', 'npy', { loaderHint: 'npy' });
  assertType('compressed.npz', 'npy', { loaderHint: 'npy' });
  assertType('image.png', 'image', { loaderHint: 'image' });
  assertType('photo.jpg', 'image', { loaderHint: 'image' });
  assertType('drawing.svg', 'image', { loaderHint: 'image' });
  assertType('config.json', 'config');
  assertType('settings.yaml', 'config');
  assertType('notes.toml', 'config');
  assertType('readme.txt', 'text');
  assertType('readme.md', 'text');
  assertType('unknown.bin', 'file');
});

// ─── script nodes ─────────────────────────────────────────────────────────────

describe('FileScanner script node properties', () => {
  let nodes: Awaited<ReturnType<FileScanner['getChildren']>>;

  beforeAll(async () => {
    const scanner = new FileScanner(path.join(tempDir, 'tree'));
    nodes = await scanner.getChildren('scripts.analysis');
  });

  it('sets type=script and language=python for .py files', () => {
    const node = nodes.find((n) => n.key === 'test_script.py');
    expect(node?.type).toBe('script');
    expect(node?.language).toBe('python');
    expect(node?.actions).toContain('run');
    expect(node?.actions).toContain('edit');
  });

  it('sets type=script and language=julia for .jl files', () => {
    const node = nodes.find((n) => n.key === 'julia_script.jl');
    expect(node?.type).toBe('script');
    expect(node?.language).toBe('julia');
  });
});

// ─── docstring extraction ─────────────────────────────────────────────────────

describe('FileScanner docstring extraction', () => {
  let nodes: Awaited<ReturnType<FileScanner['getChildren']>>;

  beforeAll(async () => {
    const scanner = new FileScanner(path.join(tempDir, 'tree'));
    nodes = await scanner.getChildren('scripts.analysis');
  });

  it('extracts Python module docstring', () => {
    const node = nodes.find((n) => n.key === 'test_script.py');
    expect(node?.preview).toBe('Test script for PDV');
  });

  it('extracts Python run() docstring when no module docstring', () => {
    const node = nodes.find((n) => n.key === 'run_doc.py');
    expect(node?.preview).toBe('Runs the analysis');
  });

  it('returns no preview for Python script with no docstring', () => {
    const node = nodes.find((n) => n.key === 'no_doc.py');
    expect(node?.preview).toBeUndefined();
  });

  it('extracts Julia module docstring', () => {
    const node = nodes.find((n) => n.key === 'julia_script.jl');
    expect(node?.preview).toBe('Julia analysis module');
  });

  it('extracts Julia run() docstring', () => {
    const node = nodes.find((n) => n.key === 'julia_run_doc.jl');
    expect(node?.preview).toBe('Runs the julia analysis');
  });
});

// ─── getChildren edge cases ───────────────────────────────────────────────────

describe('FileScanner.getChildren edge cases', () => {
  it('returns empty array for a non-existent path', async () => {
    const scanner = new FileScanner(path.join(tempDir, 'tree'));
    const result = await scanner.getChildren('does.not.exist');
    expect(result).toEqual([]);
  });

  it('returns empty array for a path pointing to a file, not a directory', async () => {
    const scanner = new FileScanner(path.join(tempDir, 'tree'));
    // 'data.config' resolves to data/config which is a file
    const result = await scanner.getChildren('data.config');
    expect(result).toEqual([]);
  });
});
