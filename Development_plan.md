# Scientific Data Viewer - Development Plan

## Mission

Build a modern, high-performance application for interactive analysis and visualization of scientific data that enables: 
- Interactive nested dictionary/data structure exploration
- Double-click and right-click method invocation (. show(), .plot(), custom methods)
- Python command execution environment for interactive analysis
- An extensible module/plugin system enabling domain scientists (non-developers) to create analysis tools
- Multi-window support with responsive UI
- Excellent performance handling large, complex data structures

## Core Principles

1. **Accessibility**: Non-developer scientists must be able to create analysis modules from templates
2. **Performance**: Large data structures (100k+ items) must remain responsive
3. **Developer Experience**: Clear separation of concerns, minimal boilerplate for module creators
4. **Maintainability**: Conservative dependency decisions; only add when benefit significantly outweighs burden
5. **Language Flexibility**: Use the right tool for the job (Python for logic, modern UI framework for frontend, C/Rust for performance-critical code)
6. **Version Stability**: Support Python 3.9+ with graceful degradation for edge cases

## Technology Stack

### Frontend / GUI
- **Framework**: Electron + React (or equivalent modern framework)
  - *Rationale*: Superior multi-window handling, modern UI patterns, native OS integration, easier deployment
  - *Alternative consideration*: PyQt6 if rapid iteration needed before Electron implementation
- **Build**:  Vite or similar modern bundler
- **Styling**: TailwindCSS or styled-components

### Backend / Data Processing
- **Core Server**: FastAPI (lightweight, async-capable, perfect for this scale)
- **Process Management**: Python subprocess with resource limits
- **Data Handling**: 
  - xarray (for n-dimensional data)
  - numpy (assumed already used)
  - pandas (assumed already used)
  - matplotlib (assumed already used)
  - scipy (for scientific computing)

### Performance-Critical Components
- **Tree/Dict Traversal**: Consider C extension if benchmarks show >10ms for 10k items
- **Rendering**: Virtual scrolling at UI layer (Electron handles this well)
- **Data Serialization**: Protocol Buffers or msgpack if JSON becomes bottleneck

### Testing & Development
- **Testing**:  pytest
- **Linting**: ruff (fast, modern alternative to flake8)
- **Type Checking**: pyright
- **Task Runner**: Just or Make

### Deployment
- **Packaging**:  PyInstaller for executables, or Electron builder
- **Distribution**: GitHub releases, optional PyPI (if server-only install), Conda

---

## Work Breakdown:  22 Pull Requests

### Phase 1: Foundation & Architecture (PRs 1-4)

**PR #1: Project Initialization & Core Architecture**
- Repository structure and build system
- Define base classes for custom data types (ShowablePlottable)
- Module system architecture design
- Backend server skeleton (FastAPI)
- CI/CD pipeline setup
- **Deliverables**:
  - Directory structure with `/frontend`, `/backend`, `/modules`
  - `backend/core/types.py` - ShowablePlottable base classes
  - `backend/core/module_system.py` - Plugin loader framework
  - `backend/main.py` - FastAPI app skeleton
  - `.github/workflows/` - test and lint workflows
  - `pyproject.toml` with minimal dependencies
  - `tests/test_module_system.py`
  - `tests/test_types.py`

**PR #2: Backend Data Management & State**
- Data structure serialization (dict → JSON/msgpack)
- Session/workspace management
- Efficient data access patterns for nested structures
- **Deliverables**:
  - `backend/core/data_manager.py` - State handling
  - `backend/core/serializer.py` - Serialization layer
  - `backend/api/data_routes.py` - REST endpoints for data access
  - `tests/test_data_manager.py`
  - `tests/test_serializer.py` with performance benchmarks

**PR #3: Frontend Scaffolding & Window Management**
- Electron app initialization
- Window manager for multi-window support
- IPC (Inter-Process Communication) setup between Electron main and renderer
- **Deliverables**:
  - `/frontend` React project structure
  - `frontend/main.js` - Electron main process
  - `frontend/preload.js` - Secure IPC bridge
  - `frontend/src/components/WindowManager.tsx`
  - `frontend/src/ipc/index.ts` - IPC wrapper
  - Integration tests for window lifecycle

**PR #4: API Specification & Backend Routes**
- Define OpenAPI spec for frontend-backend communication
- Implement core CRUD routes for data exploration
- Error handling and response formats
- **Deliverables**:
  - `backend/api/spec.yaml` or inline FastAPI docs
  - `backend/api/routes/` - All route modules
  - `backend/api/models. py` - Pydantic schemas
  - Request/response examples in docs
  - Integration tests for API endpoints

---

### Phase 2: Dictionary Viewer & Data Exploration (PRs 5-7)

**PR #5: Dictionary Viewer Component**
- React component for recursive data structure display
- Virtual scrolling for performance (10k+ items)
- Expand/collapse functionality
- Type detection and display hints
- **Deliverables**:
  - `frontend/src/components/DictViewer.tsx` - Core component
  - `frontend/src/components/TreeNode.tsx` - Individual node renderer
  - `frontend/src/hooks/useVirtualScroll.ts` - Virtualization hook
  - `frontend/src/utils/treeUtils.ts` - Tree manipulation functions
  - Performance benchmarks:  <100ms for 10k nodes on typical hardware
  - `tests/components/DictViewer.test. tsx`
  - `tests/performance/dict_viewer_perf.test.ts`

**PR #6: Right-Click Context Menu System**
- Context menu framework
- Automatic method detection (. show(), .plot(), custom methods)
- Method introspection and caching (backend)
- Menu routing
- **Deliverables**: 
  - `frontend/src/components/ContextMenu.tsx`
  - `frontend/src/hooks/useContextMenu.ts`
  - `backend/core/introspection.py` - Object introspection
  - `backend/api/routes/introspection.py` - Introspection endpoints
  - Method cache decorator in backend
  - `tests/components/ContextMenu.test.tsx`
  - `tests/test_introspection.py`

**PR #7: Method Invocation & Result Display**
- Safe method execution system (sandboxed subprocess)
- Result capture and display
- Error handling with stack traces
- Visualization rendering (for . plot() returns)
- **Deliverables**:
  - `backend/core/executor.py` - Safe method runner
  - `backend/api/routes/execute.py` - Execution endpoints
  - `frontend/src/components/ResultDisplay. tsx`
  - `frontend/src/components/ImageViewer.tsx`
  - `frontend/src/components/TextDisplay.tsx`
  - Resource limiting and timeout handling
  - `tests/test_executor.py` with timeout, exception, and resource tests

---

### Phase 3: REPL & Command Interface (PRs 8-10)

**PR #8: Python REPL Backend**
- Execution context with namespace management
- Code compilation and execution
- Output/error capture
- Variable access from executed code
- **Deliverables**:
  - `backend/core/repl.py` - REPL engine
  - `backend/api/routes/repl.py` - REPL endpoints
  - Subprocess isolation for code execution
  - `tests/test_repl.py` with comprehensive execution scenarios

**PR #9: Command Input & History UI**
- Syntax-highlighted code input (frontend)
- Command history with navigation
- Auto-completion (backend powered)
- Multi-line input support
- **Deliverables**:
  - `frontend/src/components/CommandInput.tsx`
  - `frontend/src/components/CommandHistory.tsx`
  - `frontend/src/hooks/useCommandHistory.ts`
  - `backend/core/autocomplete.py` - Completion suggestions
  - Integration with dict viewer (auto-complete variable names)
  - `tests/components/CommandInput.test.tsx`

**PR #10: Command Log & Output Display**
- Scrollable, syntax-highlighted command log
- Input/output separation
- Search and filtering
- Export functionality (save session)
- **Deliverables**:
  - `frontend/src/components/CommandLog.tsx`
  - `frontend/src/components/LogEntry.tsx`
  - `frontend/src/hooks/useLogSearch.ts`
  - Export to file/markdown functionality
  - `tests/components/CommandLog.test.tsx`

---

### Phase 4: Module System & Plugin Architecture (PRs 11-14)

**PR #11: Module Discovery & Loading**
- Filesystem-based module discovery
- Module manifest system (metadata, dependencies, entry points)
- Safe module initialization with error handling
- Module versioning and compatibility checking
- **Deliverables**:
  - `backend/modules/loader.py` - Module discovery and loading
  - `backend/modules/manifest.py` - Manifest parsing (dataclass + JSON schema)
  - `backend/modules/registry.py` - Global module registry
  - Standard module manifest schema (JSON schema file)
  - `tests/test_module_loader.py`
  - `MODULES.md` - Module developer guide (first draft)

**PR #12: Module API & Base Classes**
- BaseModule class for module developers
- Lifecycle hooks (initialize, shutdown, on_data_change)
- Data access APIs
- Logging and configuration for modules
- **Deliverables**:
  - `backend/modules/base.py` - BaseModule abstract class
  - `backend/modules/api.py` - Public API for module developers
  - `backend/modules/config.py` - Module configuration system
  - Comprehensive docstrings with examples
  - `tests/test_module_api.py`
  - Updated `MODULES.md` with API reference

**PR #13: Module GUI Integration**
- Framework for modules to register custom UI panels
- Component registration and rendering (frontend)
- Data binding between module code and UI
- Module-specific state management
- **Deliverables**:
  - `backend/modules/ui_registry.py` - UI component registration
  - `frontend/src/modules/ModulePanel.tsx` - Renderer for module UIs
  - `frontend/src/hooks/useModuleData.ts` - Data binding hook
  - `backend/api/routes/modules. py` - Module UI endpoints
  - Example module with custom UI panel
  - `tests/test_module_ui.py`
  - `tests/components/ModulePanel.test.tsx`

**PR #14: Inter-Module Communication & Events**
- Event system for module-to-module communication
- State synchronization
- Dependency management
- Transaction-like behavior for multi-step operations
- **Deliverables**:
  - `backend/modules/events.py` - Event bus
  - `backend/modules/dependencies.py` - Dependency resolver
  - Event type definitions and schemas
  - `tests/test_module_events.py`
  - `tests/test_module_dependencies.py`
  - Updated `MODULES.md` with event examples

---

### Phase 5: Example & Reference Modules (PRs 15-16)

**PR #15: Example Modules - Data Analysis**
- CSV data loader module
- Basic statistics and filtering
- Data validation checker
- These serve as templates for users
- **Deliverables**: 
  - `examples/data_loader/` - Full working module
  - `examples/statistics_analyzer/` - Full working module
  - `examples/data_validator/` - Full working module
  - Each with manifest, entry point, tests
  - README for each explaining code
  - Integration tests running examples

**PR #16: Example Modules - Visualization**
- Matplotlib integration module (plot data with . plot())
- Interactive plotting helpers
- Export visualization utilities
- **Deliverables**:
  - `examples/matplotlib_bridge/` - Full working module
  - `examples/interactive_plotter/` - Full working module
  - `examples/export_utilities/` - Full working module
  - Tests and documentation
  - Screenshots/demo in README

---

### Phase 6: Performance Optimization (PRs 17-19)

**PR #17: Data Structure Caching & Lazy Loading**
- Caching layer for frequently accessed data
- Lazy loading for large nested structures
- Pagination for very large datasets
- Cache invalidation strategies
- **Deliverables**:
  - `backend/core/cache.py` - Cache manager
  - `backend/core/lazy_loader.py` - Lazy loading strategy
  - `backend/api/routes/data.py` - Pagination support
  - `tests/test_cache.py` with correctness and performance tests
  - Benchmarks showing impact

**PR #18: Performance Profiling & Monitoring**
- Built-in performance profiler
- Slow operation detection and logging
- Memory tracking
- Frontend performance metrics (render times, API response times)
- **Deliverables**:
  - `backend/profiling/profiler.py`
  - `backend/profiling/metrics.py` - Performance metrics collection
  - `frontend/src/hooks/usePerformanceMetrics.ts`
  - `backend/api/routes/metrics.py` - Metrics endpoints
  - Debug dashboard showing performance data
  - `tests/test_profiling.py`

**PR #19: C Extension for Performance-Critical Path (Conditional)**
- Profile dictionary viewer and identify bottlenecks
- If benchmarks show >10ms for dict traversal with 10k items, implement C extension
- Tree traversal and filtering in C
- Measure before/after improvements
- **Deliverables**:
  - `backend/extensions/` - C extension code (if needed)
  - Build configuration for C extensions
  - Fallback pure-Python implementation
  - Comprehensive benchmarks
  - `tests/test_extensions.py` with performance validation
  - Installation guide for developers

---

### Phase 7: User Experience & Configuration (PRs 20-21)

**PR #20: Configuration System & Themes**
- User preferences (JSON-based, human-readable)
- Theme system (light/dark, custom colors)
- Window layout persistence
- Keyboard shortcuts customization
- **Deliverables**:
  - `backend/config/config_manager.py`
  - `backend/config/schemas.py` - JSON schema for config
  - `frontend/src/context/ThemeContext.tsx`
  - `frontend/src/hooks/useConfig.ts`
  - `frontend/src/styles/themes.ts` - Theme definitions
  - Config import/export
  - `tests/test_config.py`
  - `tests/components/ThemeProvider.test.tsx`

**PR #21: Help System, Documentation, & Logging**
- Context-sensitive help panels
- In-app tooltips and guides
- Application-wide logging with debug mode
- Issue reporting/crash reporting helpers
- **Deliverables**:
  - `backend/help/help_system.py`
  - `frontend/src/components/HelpPanel.tsx`
  - `backend/logging/logger.py` with structured logging
  - `frontend/src/utils/errorReporter.ts`
  - Help content (markdown files)
  - Debug logging configuration
  - `tests/test_help_system.py`

---

### Phase 8: Packaging, Distribution & Final Documentation (PR #22)

**PR #22: Packaging, Installation, & Complete Documentation**
- Python package setup for server component
- Electron builder configuration for client
- Installation guides (pip, conda, binary downloads)
- Comprehensive API documentation
- Module developer tutorial (step-by-step)
- Troubleshooting guide
- **Deliverables**:
  - `pyproject.toml` / `setup.py` (if needed)
  - `electron-builder.yml` configuration
  - `.github/workflows/` for building/releasing
  - `/docs` folder with: 
    - `README.md` - Quick start and overview
    - `INSTALLATION.md` - Detailed installation
    - `MODULES.md` - Module development guide (final version)
    - `API. md` - Backend API reference
    - `CONTRIBUTING.md` - Contribution guidelines
    - `TROUBLESHOOTING.md` - Common issues and fixes
  - `examples/` folder with all example modules
  - Release checklist
  - Tests for documentation examples

---

## Success Criteria

### Functionality
- [ ] Application launches in <3 seconds
- [ ] Dictionary viewer displays 100k items smoothly (virtual scrolling)
- [ ] Double-click and right-click on objects executes custom methods
- [ ] REPL executes Python code with proper error handling
- [ ] Command history persists across sessions
- [ ] Modules can be created from templates without deep Python knowledge
- [ ] Multi-window support is stable and responsive

### Performance
- [ ] Dict viewer:  <100ms load for 10k items
- [ ] REPL: <1s response for typical operations
- [ ] Memory usage stable (no leaks after 1000+ commands)
- [ ] Startup time: <3s on typical hardware

### Code Quality
- [ ] >80% test coverage for critical modules
- [ ] All linting checks pass (ruff, pyright)
- [ ] All dependencies justified in `DEVELOPMENT_PLAN.md`
- [ ] Type hints for >90% of public API

### User Experience
- [ ] Non-developer scientists can create working module from tutorial in <30 min
- [ ] All features have keyboard shortcuts
- [ ] Error messages are helpful and actionable
- [ ] Built-in help is accessible and clear

### Accessibility
- [ ] Works on Python 3.9, 3.10, 3.11, 3.12
- [ ] Builds for Linux, macOS, Windows
- [ ] Single-command installation

---

## Dependency Philosophy

Add a dependency if and only if:
1. It significantly improves performance (e.g., compiled C binding)
2. It dramatically reduces code (e.g., FastAPI vs.  http.server)
3. It is already in the domain (numpy, matplotlib, xarray, scipy)
4. It is a standard development tool (pytest, ruff)
5. It has excellent maintenance record and broad adoption

Do NOT add if:
- Feature can be implemented in <200 lines of code
- Maintenance burden is high relative to benefit
- It fragments the community (use mainstream packages)

---

## Module Developer Experience

The goal is for a domain scientist to: 

1. Copy a template from `examples/`
2. Rename files and update manifest
3. Implement 2-3 functions
4. See their module working in the app

Example module structure:
