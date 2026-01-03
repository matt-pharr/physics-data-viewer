import React, { useMemo, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TreeView, TreeNodeData } from '../../electron/src/components/DataViewer/TreeView';
import { ContextMenu } from '../../electron/src/components/ContextMenu/ContextMenu';
import { ResultWindow, DisplayResult } from '../../electron/src/components/ResultDisplay/ResultWindow';
import { MethodIntrospector, normalizeInvokeResult, pickDefaultMethod } from '../../electron/src/utils/methodIntrospection';
import { backendPath } from '../../electron/src/utils/dataFormatting';

class MockBackendClient {
  listMethods = jest.fn(async (_sid: string, path: string[]) => [
    { name: 'inspect', requires_arguments: false, path },
    { name: 'needs_args', requires_arguments: true, path },
  ]);

  invokeMethod = jest.fn(async (_sid: string, path: string[], methodName: string) => ({
    method_name: methodName,
    result: `invoked:${methodName}:${path.join('/')}`,
    result_type: 'text',
    error: null,
    traceback: null,
  }));
}

const mockClient = new MockBackendClient();

function IntegrationHarness() {
  const introspector = useMemo(() => new MethodIntrospector(mockClient as any), []);
  const [sessionId] = useState('session-1');
  const [results, setResults] = useState<DisplayResult[]>([]);
  const [contextMenu, setContextMenu] = useState<{
    position: { x: number; y: number };
    node: TreeNodeData;
    methods: { name: string; requires_arguments: boolean }[];
  } | null>(null);

  const handleDoubleClick = async (node: TreeNodeData) => {
    const methods = await introspector.getMethods(sessionId, backendPath(node.path));
    const method = pickDefaultMethod(methods);
    if (!method) return;
    const result = await mockClient.invokeMethod(sessionId, backendPath(node.path), method.name);
    setResults((prev) => [...prev, normalizeInvokeResult(result)]);
  };

  const handleContextMenu = async (node: TreeNodeData, position: { x: number; y: number }) => {
    const methods = await introspector.getMethods(sessionId, backendPath(node.path));
    setContextMenu({ node, position, methods });
  };

  const handleInvoke = async (methodName: string) => {
    if (!contextMenu) return;
    const result = await mockClient.invokeMethod(
      sessionId,
      backendPath(contextMenu.node.path),
      methodName,
    );
    setResults((prev) => [...prev, normalizeInvokeResult(result)]);
    setContextMenu(null);
  };

  return (
    <>
      <TreeView
        data={{ sample: { value: 2 } }}
        viewportHeight={200}
        onNodeDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      />
      {contextMenu && (
        <ContextMenu
          position={contextMenu.position}
          items={contextMenu.methods.map((m) => ({
            label: m.name,
            enabled: !m.requires_arguments,
            onSelect: () => handleInvoke(m.name),
          }))}
          onClose={() => setContextMenu(null)}
        />
      )}
      <ResultWindow results={results} onClear={() => setResults([])} />
    </>
  );
}

describe('Electron data viewer integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('invokes default method on double-click', async () => {
    render(<IntegrationHarness />);
    const nodes = screen.getAllByTestId('tree-node');
    const target = nodes[1]; // sample node
    fireEvent.doubleClick(target);
    await waitFor(() => expect(mockClient.invokeMethod).toHaveBeenCalled());
    expect(mockClient.invokeMethod).toHaveBeenCalledWith('session-1', ['sample'], 'inspect');
    await screen.findByText(/invoked:inspect/);
  });

  it('shows context menu and runs selected method', async () => {
    render(<IntegrationHarness />);
    const nodes = screen.getAllByTestId('tree-node');
    const target = nodes[1];
    fireEvent.contextMenu(target, { clientX: 5, clientY: 5 });
    const menu = await screen.findByTestId('context-menu');
    expect(menu).toBeInTheDocument();
    const button = screen.getByText('inspect');
    fireEvent.click(button);
    await waitFor(() => expect(mockClient.invokeMethod).toHaveBeenCalledTimes(1));
    await screen.findByText(/invoked:inspect/);
  });
});
