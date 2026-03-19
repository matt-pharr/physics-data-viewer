import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';

type LeftPanel = 'tree' | 'namespace';
type DragMode = 'vertical' | 'horizontal' | null;

export function useLayoutState() {
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(
    () => localStorage.getItem('pdv.layout.leftSidebarOpen') !== 'false'
  );
  const [leftPanel, setLeftPanel] = useState<LeftPanel>(
    () => (localStorage.getItem('pdv.layout.leftPanel') as LeftPanel) || 'tree'
  );
  const [editorCollapsed, setEditorCollapsed] = useState(
    () => localStorage.getItem('pdv.layout.editorCollapsed') === 'true'
  );
  const [leftWidth, setLeftWidth] = useState(() => {
    const saved = localStorage.getItem('pdv.pane.leftWidth');
    return saved ? Number(saved) : 340;
  });
  const [editorHeight, setEditorHeight] = useState(() => {
    const saved = localStorage.getItem('pdv.pane.editorHeight');
    return saved ? Number(saved) : 260;
  });
  const dragRef = useRef<DragMode>(null);
  const dragOffsetRef = useRef<number>(0);
  const rightPaneRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!dragRef.current) return;
      if (dragRef.current === 'vertical') {
        const viewportWidth = window.innerWidth || 1200;
        const max = Math.max(200, viewportWidth - 300);
        const next = Math.min(Math.max(event.clientX - dragOffsetRef.current, 200), max);
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
    dragOffsetRef.current = event.clientX - leftWidth;
    dragRef.current = 'vertical';
  }, [leftWidth]);

  const startHorizontalDrag = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    dragRef.current = 'horizontal';
  }, []);

  const handleActivityBarClick = useCallback((panel: LeftPanel) => {
    if (leftSidebarOpen && leftPanel === panel) {
      setLeftSidebarOpen(false);
      localStorage.setItem('pdv.layout.leftSidebarOpen', 'false');
    } else {
      setLeftPanel(panel);
      setLeftSidebarOpen(true);
      localStorage.setItem('pdv.layout.leftPanel', panel);
      localStorage.setItem('pdv.layout.leftSidebarOpen', 'true');
    }
  }, [leftSidebarOpen, leftPanel]);

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

  const expandEditor = useCallback(() => {
    setEditorCollapsed(false);
    localStorage.setItem('pdv.layout.editorCollapsed', 'false');
  }, []);

  return {
    leftSidebarOpen,
    leftPanel,
    editorCollapsed,
    leftWidth,
    editorHeight,
    rightPaneRef,
    startVerticalDrag,
    startHorizontalDrag,
    handleActivityBarClick,
    toggleLeftSidebar,
    toggleEditorCollapsed,
    collapseLeftSidebar,
    expandEditor,
  };
}
