/**
 * math-preview.ts — KaTeX inline math previews for the Monaco markdown editor.
 *
 * Scans the editor model for math delimiters ($...$ and $$...$$), renders them
 * via KaTeX, and displays the output using Monaco ViewZones (display math) and
 * content widgets (inline math). Previews are always visible alongside source.
 *
 * Does NOT modify the document — all rendering is purely decorative.
 */

import katex from 'katex';
import type * as monaco from 'monaco-editor';

/** Parsed math region in the document. */
export interface MathRegion {
  /** LaTeX source text (without delimiters). */
  latex: string;
  /** True for display math ($$...$$), false for inline ($...$). */
  displayMode: boolean;
  /** 1-based start line number. */
  startLine: number;
  /** 1-based start column. */
  startCol: number;
  /** 1-based end line number (line containing closing delimiter). */
  endLine: number;
  /** 1-based column after the closing delimiter. */
  endCol: number;
}

/**
 * Scan document text for math delimiters.
 *
 * Rules (mirror marked-katex-extension so edit-mode previews match read-mode
 * rendering):
 * - Block display math: `$$` alone on a line (only whitespace around),
 *   closed by another `$$` alone on a later line. Content may span lines.
 * - Inline display math: `$$...$$` on a single line.
 * - Inline math: `$...$` on a single line.
 * - Math inside fenced code blocks (``` ... ```) is ignored.
 * - Escaped delimiters (\$) are skipped as delimiters.
 */
export function scanMathRegions(text: string): MathRegion[] {
  const lines = text.split('\n');
  const regions: MathRegion[] = [];
  let inCodeBlock = false;

  const isBlockDelimiter = (s: string) => /^\s*\$\$\s*$/.test(s);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      i++;
      continue;
    }
    if (inCodeBlock) {
      i++;
      continue;
    }

    // Block display math — `$$` alone on a line, closed by another `$$` alone.
    if (isBlockDelimiter(line)) {
      let closeLine = -1;
      let searchInCode = false;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*```/.test(lines[j])) {
          searchInCode = !searchInCode;
          continue;
        }
        if (searchInCode) continue;
        if (isBlockDelimiter(lines[j])) {
          closeLine = j;
          break;
        }
      }
      if (closeLine !== -1) {
        const latex = lines.slice(i + 1, closeLine).join('\n');
        if (latex.trim().length > 0) {
          const openCol = line.indexOf('$') + 1; // 1-based
          regions.push({
            latex,
            displayMode: true,
            startLine: i + 1,
            startCol: openCol,
            endLine: closeLine + 1,
            endCol: lines[closeLine].length + 1,
          });
        }
        i = closeLine + 1;
        continue;
      }
      // Unpaired block delimiter — fall through to inline scan for this line.
    }

    scanInlineOnLine(line, i, regions);
    i++;
  }

  return regions;
}

/** Scan a single line for inline $...$ and inline $$...$$ math. */
function scanInlineOnLine(line: string, lineIdx: number, regions: MathRegion[]): void {
  let col = 0;
  while (col < line.length) {
    if (line[col] === '\\' && line[col + 1] === '$') {
      col += 2;
      continue;
    }
    if (line[col] !== '$') {
      col++;
      continue;
    }

    const isDouble = line[col + 1] === '$';
    const delimLen = isDouble ? 2 : 1;
    const openEnd = col + delimLen;
    let close = openEnd;
    let closed = false;

    while (close < line.length) {
      if (line[close] === '\\' && line[close + 1] === '$') {
        close += 2;
        continue;
      }
      if (line[close] === '$') {
        if (isDouble) {
          if (line[close + 1] === '$') {
            closed = true;
            break;
          }
          close++;
          continue;
        }
        closed = true;
        break;
      }
      close++;
    }

    if (!closed) {
      col += delimLen;
      continue;
    }

    const latex = line.slice(openEnd, close);
    if (latex.trim().length > 0) {
      regions.push({
        latex,
        displayMode: isDouble,
        startLine: lineIdx + 1,
        startCol: col + 1,
        endLine: lineIdx + 1,
        endCol: close + delimLen + 1,
      });
    }
    col = close + delimLen;
  }
}

/** Render a LaTeX string to HTML via KaTeX. Returns HTML or error markup. */
function renderLatex(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, {
      throwOnError: false,
      displayMode,
    });
  } catch {
    return `<span style="color:red;">[KaTeX error]</span>`;
  }
}

// ─── Monaco Integration ─────────────────────────────────────────────────

interface ActiveViewZone {
  id: string;
  endLine: number;
}

/**
 * Build a ViewZone for a single math region, pre-measure its rendered
 * height in the editor's DOM context, and register it with Monaco.
 * Returns the zone descriptor so the caller can track it for teardown,
 * or null if the editor has no DOM container (shouldn't happen in practice).
 */
function createPreviewZone(
  editor: monaco.editor.IStandaloneCodeEditor,
  region: MathRegion,
  html: string,
): ActiveViewZone | null {
  const container = editor.getDomNode();
  if (!container) return null;

  const domNode = document.createElement('div');
  domNode.className = region.displayMode
    ? 'math-preview-zone'
    : 'math-preview-zone math-preview-inline-zone';
  domNode.innerHTML = html;
  domNode.style.padding = region.displayMode ? '4px 16px' : '2px 16px';
  domNode.style.opacity = region.displayMode ? '0.9' : '0.85';
  domNode.style.textAlign = 'left';

  // Pre-measure off-screen so Monaco allocates the correct height. Attach
  // to the editor's DOM so inherited fonts and sizing match the final zone.
  domNode.style.position = 'absolute';
  domNode.style.visibility = 'hidden';
  container.appendChild(domNode);
  const fallbackHeight = region.displayMode ? 40 : 24;
  const measuredHeight = domNode.getBoundingClientRect().height || fallbackHeight;
  container.removeChild(domNode);
  domNode.style.position = '';
  domNode.style.visibility = '';

  let zoneId = '';
  editor.changeViewZones((accessor) => {
    zoneId = accessor.addZone({
      afterLineNumber: region.endLine,
      heightInPx: measuredHeight,
      domNode,
      // Omit afterColumn so Monaco uses the line's max column; otherwise on
      // a word-wrapped source line the zone anchors to the first visual row
      // instead of after the last wrap.
      suppressMouseDown: true,
    });
  });
  return { id: zoneId, endLine: region.endLine };
}

/**
 * Attach math preview rendering to a Monaco editor instance.
 * Returns a dispose function that cleans up all widgets and zones.
 */
export function attachMathPreview(
  editor: monaco.editor.IStandaloneCodeEditor,
  _monacoModule: typeof monaco,
): () => void {
  let activeZones: ActiveViewZone[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const refresh = () => {
    const model = editor.getModel();
    if (!model) return;
    const text = model.getValue();
    const regions = scanMathRegions(text);

    // Remove existing zones
    editor.changeViewZones((accessor) => {
      for (const zone of activeZones) {
        accessor.removeZone(zone.id);
      }
    });
    activeZones = [];

    // Create new zones/widgets for each region
    for (const region of regions) {
      const html = renderLatex(region.latex, region.displayMode);
      const zone = createPreviewZone(editor, region, html);
      if (zone) activeZones.push(zone);
    }
  };

  // Debounced refresh on content change
  const debouncedRefresh = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, 300);
  };

  // Initial render
  refresh();

  // Subscribe to content changes
  const disposable = editor.onDidChangeModelContent(debouncedRefresh);

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    disposable.dispose();
    editor.changeViewZones((accessor) => {
      for (const zone of activeZones) {
        accessor.removeZone(zone.id);
      }
    });
    activeZones = [];
  };
}
