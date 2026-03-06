/**
 * monaco-providers.ts — Monaco completion and hover providers for CodeCell.
 *
 * Registers language-level providers that query the active Jupyter kernel
 * for Python completions (via `kernels.complete`) and hover documentation
 * (via `kernels.inspect`). Also provides tree-path–aware completions for
 * `pdv_tree["..."]` navigation expressions.
 *
 * Providers are registered globally (Monaco providers are page-singletons)
 * but read current kernel/tab state through refs passed at registration time.
 */

import type * as monaco from 'monaco-editor';
import type React from 'react';

// Registration guards — Monaco providers are page-level singletons.
let completionProviderRegistered = false;
let hoverProviderRegistered = false;

interface TabSnapshot {
  id: number;
  code: string;
  active: boolean;
}

/** Returns a newline-terminated string of all non-active tabs' code to give jedi cross-cell import context. */
function buildContextPrefix(
  tabsRef: React.MutableRefObject<TabSnapshot[]>
): string {
  const tabs = tabsRef.current;
  const otherCode = tabs
    .filter((t) => !t.active)
    .map((t) => t.code.trim())
    .filter(Boolean)
    .join('\n');
  return otherCode ? otherCode + '\n' : '';
}

interface TreePathCompletionContext {
  ancestorSegments: string[];
  typedSegment: string;
  segmentStartOffset: number;
}

function extractTreePathCompletionContext(
  code: string,
  offset: number
): TreePathCompletionContext | null {
  const textBeforeCursor = code.slice(0, offset);
  const match = /pdv_tree((?:\[\s*['"][^'"\\]*['"]\s*\])*)\[\s*['"]([^'"\\]*)$/.exec(
    textBeforeCursor
  );
  if (!match) return null;
  const completedSegments = match[1];
  const typedSegment = match[2];
  const ancestorSegments: string[] = [];
  const segmentRegex = /\[\s*['"]([^'"\\]*)['"]\s*\]/g;
  let segmentMatch: RegExpExecArray | null;
  while ((segmentMatch = segmentRegex.exec(completedSegments)) !== null) {
    ancestorSegments.push(segmentMatch[1]);
  }
  return {
    ancestorSegments,
    typedSegment,
    segmentStartOffset: offset - typedSegment.length,
  };
}

interface TreePathSuggestion {
  label: string;
  insertText: string;
}

async function getTreePathSuggestions(
  kernelId: string,
  context: TreePathCompletionContext
): Promise<TreePathSuggestion[]> {
  const typedParts = context.typedSegment.split('.');
  const extraParentSegments =
    typedParts.length > 1 ? typedParts.slice(0, -1).filter(Boolean) : [];
  const keyPrefix = typedParts[typedParts.length - 1] ?? '';
  const parentSegments = [...context.ancestorSegments, ...extraParentSegments];
  const parentPath = parentSegments.join('.');
  const nodes = await window.pdv.tree.list(kernelId, parentPath);
  return nodes
    .filter((node) => node.key.startsWith(keyPrefix))
    .map((node) => ({
      label: node.path,
      insertText: [...extraParentSegments, node.key].join('.'),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function mapCompletionKind(
  monacoInstance: typeof monaco,
  rawType: string | undefined
): monaco.languages.CompletionItemKind {
  switch (rawType) {
    case 'function':
    case 'builtin_function_or_method':
      return monacoInstance.languages.CompletionItemKind.Function;
    case 'module':
      return monacoInstance.languages.CompletionItemKind.Module;
    case 'class':
      return monacoInstance.languages.CompletionItemKind.Class;
    case 'keyword':
      return monacoInstance.languages.CompletionItemKind.Keyword;
    case 'property':
      return monacoInstance.languages.CompletionItemKind.Property;
    case 'statement':
      return monacoInstance.languages.CompletionItemKind.Snippet;
    case 'instance':
      return monacoInstance.languages.CompletionItemKind.Variable;
    default:
      return monacoInstance.languages.CompletionItemKind.Variable;
  }
}

/**
 * Register the kernel-backed Python completion provider with Monaco.
 *
 * Supports both standard Jedi completions and pdv_tree path navigation.
 * No-ops if already registered (providers are page-level singletons).
 */
export function registerKernelCompletionProvider(
  monacoInstance: typeof monaco,
  kernelIdRef: React.MutableRefObject<string | null>,
  tabsRef: React.MutableRefObject<TabSnapshot[]>
): void {
  if (completionProviderRegistered) return;
  completionProviderRegistered = true;

  monacoInstance.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.', '[', "'", '"'],
    async provideCompletionItems(model, position, context) {
      const kernelId = kernelIdRef.current;
      if (!kernelId) return { suggestions: [] };

      const code = model.getValue();
      const offset = model.getOffsetAt(position);
      const treePathContext = extractTreePathCompletionContext(code, offset);
      if (treePathContext) {
        try {
          const matches = await getTreePathSuggestions(
            kernelId,
            treePathContext
          );
          const startPosition = model.getPositionAt(treePathContext.segmentStartOffset);
          const endPosition = model.getPositionAt(offset);
          const range = new monacoInstance.Range(
            startPosition.lineNumber,
            startPosition.column,
            endPosition.lineNumber,
            endPosition.column
          );
          return {
            suggestions: matches.map((match, index) => ({
              label: match.label,
              kind: monacoInstance.languages.CompletionItemKind.Variable,
              insertText: match.insertText,
              range,
              sortText: String(index).padStart(5, '0'),
            })),
          };
        } catch (error) {
          console.warn('[CodeCell] Tree path completion request failed', error);
          return { suggestions: [] };
        }
      }

      if (
        context?.triggerCharacter === "'" ||
        context?.triggerCharacter === '"'
      ) {
        return { suggestions: [] };
      }

      try {
        const prefix = buildContextPrefix(tabsRef);
        const prefixedCode = prefix + code;
        const prefixedOffset = prefix.length + offset;
        const result = await window.pdv.kernels.complete(kernelId, prefixedCode, prefixedOffset);
        const textBeforeCursor = code.slice(0, offset);
        const namePrefix = textBeforeCursor.match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0] ?? '';
        let mergedMatches = [...result.matches];
        // ipykernel completion can omit protected PDV locals from top-level name
        // completion; ensure the two built-ins are always discoverable.
        if (namePrefix) {
          for (const builtin of ['pdv_tree', 'pdv']) {
            if (builtin.startsWith(namePrefix) && !mergedMatches.includes(builtin)) {
              mergedMatches.push(builtin);
            }
          }
        }
        const adjustedStart = Math.max(0, result.cursor_start - prefix.length);
        const adjustedEnd = Math.max(0, result.cursor_end - prefix.length);
        const startPosition = model.getPositionAt(adjustedStart);
        const endPosition = model.getPositionAt(adjustedEnd);
        const range = new monacoInstance.Range(
          startPosition.lineNumber,
          startPosition.column,
          endPosition.lineNumber,
          endPosition.column
        );

        const kindByMatch = new Map<string, monaco.languages.CompletionItemKind>();
        const experimental = result.metadata?._jupyter_types_experimental;
        if (Array.isArray(experimental)) {
          for (const item of experimental) {
            if (
              item &&
              typeof item === 'object' &&
              'text' in item &&
              'type' in item &&
              typeof item.text === 'string' &&
              typeof item.type === 'string'
            ) {
              kindByMatch.set(item.text, mapCompletionKind(monacoInstance, item.type));
            }
          }
        }

        return {
          suggestions: mergedMatches.map((match, index) => ({
            label: match,
            kind: kindByMatch.get(match) ?? monacoInstance.languages.CompletionItemKind.Variable,
            insertText: match,
            range,
            sortText: String(index).padStart(5, '0'),
          })),
        };
      } catch (error) {
        console.warn('[CodeCell] Completion request failed', error);
        return { suggestions: [] };
      }
    },
  });
}

/**
 * Register the kernel-backed Python hover provider with Monaco.
 *
 * Shows docstrings and type info on hover via `kernels.inspect`.
 * No-ops if already registered (providers are page-level singletons).
 */
export function registerKernelHoverProvider(
  monacoInstance: typeof monaco,
  kernelIdRef: React.MutableRefObject<string | null>,
  tabsRef: React.MutableRefObject<TabSnapshot[]>
): void {
  if (hoverProviderRegistered) return;
  hoverProviderRegistered = true;

  monacoInstance.languages.registerHoverProvider('python', {
    async provideHover(model, position) {
      const kernelId = kernelIdRef.current;
      if (!kernelId) return null;

      try {
        const code = model.getValue();
        const prefix = buildContextPrefix(tabsRef);
        const offset = prefix.length + model.getOffsetAt(position);
        const result = await window.pdv.kernels.inspect(kernelId, prefix + code, offset);
        const rawDoc = result.data?.['text/plain'];
        if (!result.found || typeof rawDoc !== 'string' || !rawDoc.trim()) {
          return null;
        }
        // Strip ANSI escape sequences (color/bold codes) that ipykernel injects for terminal display.
        const doc = rawDoc.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

        const word = model.getWordAtPosition(position);
        return {
          contents: [{ value: `\`\`\`text\n${doc}\n\`\`\`` }],
          range: word
            ? new monacoInstance.Range(
              position.lineNumber,
              word.startColumn,
              position.lineNumber,
              word.endColumn
            )
            : undefined,
        };
      } catch (error) {
        console.warn('[CodeCell] Inspect request failed', error);
        return null;
      }
    },
  });
}
