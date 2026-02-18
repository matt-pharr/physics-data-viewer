# Physics Data Viewer Tests

This directory contains the test suites for the Physics Data Viewer application.

## Test Organization

The tests are organized into separate suites for different parts of the application:

### GUI Tests (TypeScript/JavaScript)
Located in `electron/` subdirectories
- Run with: `npm test` (from electron directory)
- Tests the Electron app, IPC handlers, UI components, and frontend logic
- Uses Vitest as the test runner

### Python Backend Tests
Located in `tests/python/`
- Run with: `pytest` (from tests/python directory)
- Tests the Python backend, PDVTree, and script runner
- Uses pytest as the test runner
- See [tests/python/README.md](python/README.md) for details

### Julia Backend Tests
Located in `tests/julia/`
- **NOT YET IMPLEMENTED** - Scaffolding only
- Will test the Julia backend when implemented
- See [tests/julia/README.md](julia/README.md) for details

## Quick Start

### Running GUI Tests

```bash
cd electron
npm install
npm test
```

### Running Python Backend Tests

```bash
cd tests/python
pip install -r requirements.txt
pytest -v
```

### Running Julia Backend Tests

```bash
# Not yet implemented
cd tests/julia
julia runtests.jl
```

## Continuous Integration

In CI environments:
- GUI tests run automatically via `npm test`
- Python tests can be run with `pytest` after installing dependencies
- Julia tests are not yet implemented

## Test Coverage

To generate coverage reports:

**Python:**
```bash
cd tests/python
pytest --cov=../../electron/main/init --cov-report=html -v
```

**GUI (TypeScript):**
```bash
cd electron
npm test -- --coverage
```
