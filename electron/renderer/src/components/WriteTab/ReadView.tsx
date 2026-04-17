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

// marked-katex-extension's block rule requires the opening/closing `$$` line
// to end exactly in `\n` — trailing spaces on the delimiter line silently
// break block math. Strip that whitespace before parsing.
function normalizeMathDelimiters(src: string): string {
  return src.replace(/^([ \t]*\${1,2})[ \t]+$/gm, '$1');
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
