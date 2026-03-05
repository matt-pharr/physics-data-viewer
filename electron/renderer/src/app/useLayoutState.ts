import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

export type LeftPanel = 'tree' | 'namespace';
export type RightPanel = 'library' | 'imported';
type DragMode = 'vertical' | 'horizontal' | 'right-vertical' | null;

export function useLayoutState() {
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(
    () => localStorage.getItem('pdv.layout.leftSidebarOpen') !== 'false'
  );
  const [leftPanel, setLeftPanel] = useState<LeftPanel>(
    () => (localStorage.getItem('pdv.layout.leftPanel') as LeftPanel) || 'tree'
  );
  const [rightSidebarOpen, setRightSidebarOpen] = useState(
    () => localStorage.getItem('pdv.layout.rightSidebar') !== 'false'
  );
  const [rightPanel, setRightPanel] = useState<RightPanel>(
    () => (localStorage.getItem('pdv.layout.rightPanel') as RightPanel) || 'imported'
  );
  const [editorCollapsed, setEditorCollapsed] = useState(
    () => localStorage.getItem('pdv.layout.editorCollapsed') === 'true'
  );
  const [leftWidth, setLeftWidth] = useState(() => {
    const saved = localStorage.getItem('pdv.pane.leftWidth');
    return saved ? Number(saved) : 340;
  });
  const [rightWidth, setRightWidth] = useState(() => {
    const saved = localStorage.getItem('pdv.pane.rightWidth');
    return saved ? Number(saved) : 280;
  });
  const [editorHeight, setEditorHeight] = useState(() => {
    const saved = localStorage.getItem('pdv.pane.editorHeight');
    return saved ? Number(saved) : 260;
  });
  const dragRef = useRef<DragMode>(null);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!dragRef.current) return;
      if (dragRef.current === 'vertical') {
        const viewportWidth = window.innerWidth || 1200;
        const max = Math.max(200, viewportWidth - 300);
        const next = Math.min(Math.max(event.clientX, 200), max);
        setLeftWidth(next);
        localStorage.setItem('pdv.pane.leftWidth', String(next));
      } else if (dragRef.current === 'horizontal') {
        const bounds = rightPaneRef.current?.getBoundingClientRect();
        if (!bounds) return;
        const relativeY = bounds.bottom - event.clientY;
        const min = 140;
        const max = Math.max(min, bounds.height - 180);
        const next = Math.min(Math.max(relativeY, min), max);
        setEditorHeight(next);
        localStorage.setItem('pdv.pane.editorHeight', String(next));
      } else if (dragRef.current === 'right-vertical') {
        const viewportWidth = window.innerWidth || 1200;
        const min = 150;
        const max = Math.max(min, viewportWidth - 400);
        const next = Math.min(Math.max(viewportWidth - event.clientX, min), max);
        setRightWidth(next);
        localStorage.setItem('pdv.pane.rightWidth', String(next));
      }
    };

    const handleUp = () => {
      dragRef.current = null;
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  const startVerticalDrag = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    dragRef.current = 'vertical';
  }, []);

  const startHorizontalDrag = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    dragRef.current = 'horizontal';
  }, []);

  const startRightDrag = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    dragRef.current = 'right-vertical';
  }, []);

  const handleActivityBarClick = useCallback((panel: LeftPanel | RightPanel) => {
    if (panel === 'library' || panel === 'imported') {
      if (rightSidebarOpen && rightPanel === panel) {
        setRightSidebarOpen(false);
        localStorage.setItem('pdv.layout.rightSidebar', 'false');
      } else {
        setRightPanel(panel);
        setRightSidebarOpen(true);
        localStorage.setItem('pdv.layout.rightPanel', panel);
        localStorage.setItem('pdv.layout.rightSidebar', 'true');
      }
    } else {
      if (leftSidebarOpen && leftPanel === panel) {
        setLeftSidebarOpen(false);
        localStorage.setItem('pdv.layout.leftSidebarOpen', 'false');
      } else {
        setLeftPanel(panel);
        setLeftSidebarOpen(true);
        localStorage.setItem('pdv.layout.leftPanel', panel);
        localStorage.setItem('pdv.layout.leftSidebarOpen', 'true');
      }
    }
  }, [leftSidebarOpen, leftPanel, rightSidebarOpen, rightPanel]);

  const toggleLeftSidebar = useCallback(() => {
    setLeftSidebarOpen((prev) => {
      const next = !prev;
      localStorage.setItem('pdv.layout.leftSidebarOpen', String(next));
      return next;
    });
  }, []);

  const toggleEditorCollapsed = useCallback(() => {
    setEditorCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('pdv.layout.editorCollapsed', String(next));
      return next;
    });
  }, []);

  const collapseLeftSidebar = useCallback(() => {
    setLeftSidebarOpen(false);
    localStorage.setItem('pdv.layout.leftSidebarOpen', 'false');
  }, []);

  const collapseRightSidebar = useCallback(() => {
    setRightSidebarOpen(false);
    localStorage.setItem('pdv.layout.rightSidebar', 'false');
  }, []);

  const expandEditor = useCallback(() => {
    setEditorCollapsed(false);
    localStorage.setItem('pdv.layout.editorCollapsed', 'false');
  }, []);

  return {
    leftSidebarOpen,
    leftPanel,
    rightSidebarOpen,
    rightPanel,
    editorCollapsed,
    leftWidth,
    rightWidth,
    editorHeight,
    rightPaneRef,
    startVerticalDrag,
    startHorizontalDrag,
    startRightDrag,
    handleActivityBarClick,
    toggleLeftSidebar,
    toggleEditorCollapsed,
    collapseLeftSidebar,
    collapseRightSidebar,
    expandEditor,
  };
}
