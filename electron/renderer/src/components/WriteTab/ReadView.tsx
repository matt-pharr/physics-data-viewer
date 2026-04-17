/**
 * ReadView — rendered markdown view with KaTeX math support.
 *
 * Converts markdown content to styled HTML using the `marked` library with
 * the `marked-katex-extension` for LaTeX math rendering. Displayed when the
 * user toggles Read mode in the WriteTab.
 *
 * Does NOT modify the document — this is a read-only presentation view.
 */

import React, { useMemo } from 'react';
import { Marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import 'katex/dist/katex.min.css';

const marked = new Marked();
marked.use(markedKatex({ throwOnError: false, nonStandard: true }));

// Preprocess source so common authoring patterns render correctly:
//
// 1. marked-katex-extension's block rule requires the `$$` delimiter line
//    to end exactly in `\n` — trailing spaces silently break block math.
// 2. The block rule only fires if `$$` sits in its own block, which for
//    marked means blank lines above and below. A note like
//       Formula:
//       $$ ... $$
//    otherwise gets folded into the surrounding paragraph and the math
//    is rendered as literal text. We pad blank lines around any line
//    containing just `$$` (or `$`) so this "just works".
// 3. Empty math (`$ $`, `$$  $$`) is almost always a typo; the nonStandard
//    rule matches it greedily and emits an empty KaTeX span. Escape those
//    delimiters so they render as literal `$`.
export function normalizeMathDelimiters(src: string): string {
  let out = src.replace(/^([ \t]*\${1,2})[ \t]+$/gm, '$1');
  out = out.replace(/(\${1,2})([ \t]+)\1(?!\w)/g, (_m, d: string, sp: string) => {
    const escaped = d.replace(/\$/g, '\\$');
    return escaped + sp + escaped;
  });
  out = out.replace(/([^\n])\n(\${1,2})(?=\n|$)/g, '$1\n\n$2');
  out = out.replace(/(^|\n)(\${1,2})\n(?!\n)/g, '$1$2\n\n');
  return out;
}

interface ReadViewProps {
  content: string;
}

/** Full-page rendered markdown view with KaTeX math support. */
export const ReadView: React.FC<ReadViewProps> = ({ content }) => {
  const html = useMemo(() => {
    try {
      return marked.parse(normalizeMathDelimiters(content)) as string;
    } catch {
      return '<p style="color:red;">[Markdown render error]</p>';
    }
  }, [content]);

  return (
    <div
      className="read-view-content"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
