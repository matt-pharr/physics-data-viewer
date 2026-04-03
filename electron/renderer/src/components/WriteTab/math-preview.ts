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
 * Rules:
 * - `$$...$$` is display math (may span multiple lines)
 * - `$...$` is inline math (single line only, no nested $)
 * - Math inside fenced code blocks (``` ... ```) is ignored
 * - Escaped delimiters (\$) are ignored
 */
export function scanMathRegions(text: string): MathRegion[] {
  const lines = text.split('\n');
  const regions: MathRegion[] = [];
  let inCodeBlock = false;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Toggle fenced code blocks
    if (/^```/.test(line.trimStart())) {
      inCodeBlock = !inCodeBlock;
      i++;
      continue;
    }
    if (inCodeBlock) {
      i++;
      continue;
    }

    // Scan for display math ($$...$$) — may span lines
    let col = 0;
    while (col < line.length) {
      // Skip escaped dollar signs
      if (line[col] === '\\' && col + 1 < line.length && line[col + 1] === '$') {
        col += 2;
        continue;
      }

      // Display math opening: $$
      if (line[col] === '$' && col + 1 < line.length && line[col + 1] === '$') {
        const startLine = i + 1;
        const startCol = col + 1;
        const openEnd = col + 2;

        // Search for closing $$
        let found = false;
        let searchLine = i;
        let searchCol = openEnd;

        while (searchLine < lines.length) {
          const sLine = lines[searchLine];
          while (searchCol < sLine.length) {
            if (sLine[searchCol] === '\\' && searchCol + 1 < sLine.length && sLine[searchCol + 1] === '$') {
              searchCol += 2;
              continue;
            }
            if (sLine[searchCol] === '$' && searchCol + 1 < sLine.length && sLine[searchCol + 1] === '$') {
              // Found closing $$
              const latex = extractText(lines, i, openEnd, searchLine, searchCol);
              if (latex.trim().length > 0) {
                regions.push({
                  latex,
                  displayMode: true,
                  startLine,
                  startCol,
                  endLine: searchLine + 1,
                  endCol: searchCol + 3, // after $$
                });
              }
              // Advance past the closing $$
              if (searchLine === i) {
                col = searchCol + 2;
              } else {
                i = searchLine;
                col = searchCol + 2;
              }
              found = true;
              break;
            }
            searchCol++;
          }
          if (found) break;
          searchLine++;
          searchCol = 0;
        }

        if (found) continue;
        // No closing $$ found — skip this $$
        col = openEnd;
        continue;
      }

      // Inline math: single $...$  (same line only)
      if (line[col] === '$') {
        const openEnd = col + 1;
        let closeCol = openEnd;
        let found = false;

        while (closeCol < line.length) {
          if (line[closeCol] === '\\' && closeCol + 1 < line.length && line[closeCol + 1] === '$') {
            closeCol += 2;
            continue;
          }
          if (line[closeCol] === '$') {
            // Avoid empty match
            if (closeCol > openEnd) {
              const latex = line.slice(openEnd, closeCol);
              regions.push({
                latex,
                displayMode: false,
                startLine: i + 1,
                startCol: col + 1,
                endLine: i + 1,
                endCol: closeCol + 2, // after closing $
              });
              col = closeCol + 1;
              found = true;
            }
            break;
          }
          closeCol++;
        }

        if (found) continue;
        col++;
        continue;
      }

      col++;
    }

    i++;
  }

  return regions;
}

/** Extract text between two (line, col) positions in a line array. */
function extractText(
  lines: string[],
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
): string {
  if (startLine === endLine) {
    return lines[startLine].slice(startCol, endCol);
  }
  const parts: string[] = [];
  parts.push(lines[startLine].slice(startCol));
  for (let l = startLine + 1; l < endLine; l++) {
    parts.push(lines[l]);
  }
  parts.push(lines[endLine].slice(0, endCol));
  return parts.join('\n');
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
 * Attach math preview rendering to a Monaco editor instance.
 * Returns a dispose function that cleans up all widgets and zones.
 */
export function attachMathPreview(
  editor: monaco.editor.IStandaloneCodeEditor,
  monacoModule: typeof monaco,
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

      if (region.displayMode) {
        // Display math: ViewZone below the closing $$ line.
        // Pre-measure the rendered height so Monaco allocates the right
        // amount of space and the preview doesn't overlap editor text.
        const domNode = document.createElement('div');
        domNode.className = 'math-preview-zone';
        domNode.innerHTML = html;
        domNode.style.padding = '4px 16px';
        domNode.style.opacity = '0.9';
        domNode.style.textAlign = 'left';

        // Measure off-screen: attach to the editor's DOM container so
        // inherited fonts / sizing are accurate, then read the height.
        const container = editor.getDomNode();
        if (!container) continue;
        domNode.style.position = 'absolute';
        domNode.style.visibility = 'hidden';
        container.appendChild(domNode);
        const measuredHeight = domNode.getBoundingClientRect().height || 40;
        container.removeChild(domNode);
        domNode.style.position = '';
        domNode.style.visibility = '';

        editor.changeViewZones((accessor) => {
          const id = accessor.addZone({
            afterLineNumber: region.endLine,
            heightInPx: measuredHeight,
            domNode,
            afterColumn: 0,
            suppressMouseDown: true,
          });
          activeZones.push({ id, endLine: region.endLine });
        });
      } else {
        // Inline math: ViewZone below the source line (same pre-measure
        // approach as display math, but rendered at inline size).
        const domNode = document.createElement('div');
        domNode.className = 'math-preview-zone math-preview-inline-zone';
        domNode.innerHTML = html;
        domNode.style.padding = '2px 16px';
        domNode.style.opacity = '0.85';
        domNode.style.textAlign = 'left';

        const container = editor.getDomNode();
        if (!container) continue;
        domNode.style.position = 'absolute';
        domNode.style.visibility = 'hidden';
        container.appendChild(domNode);
        const measuredHeight = domNode.getBoundingClientRect().height || 24;
        container.removeChild(domNode);
        domNode.style.position = '';
        domNode.style.visibility = '';

        editor.changeViewZones((accessor) => {
          const id = accessor.addZone({
            afterLineNumber: region.endLine,
            heightInPx: measuredHeight,
            domNode,
            afterColumn: 0,
            suppressMouseDown: true,
          });
          activeZones.push({ id, endLine: region.endLine });
        });
      }
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
