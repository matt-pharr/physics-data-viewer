# Physics Data Viewer (PDV)

Physics Data Viewer is an Electron desktop app for physics analysis workflows.
The architecture is documented in [`ARCHITECTURE.md`](./ARCHITECTURE.md), and
the implementation sequence is tracked in [`IMPLEMENTATION_STEPS.md`](./IMPLEMENTATION_STEPS.md).

## Developer setup

### 1) Install Python package in editable mode

```bash
cd pdv-python
python -m pip install -e ".[dev]"
```

### 2) Install Electron dependencies

```bash
cd electron
npm install
```

## Running tests

### Python unit tests

```bash
cd pdv-python
pytest tests/ -v --tb=short
```

### Electron TypeScript tests

```bash
cd electron
npm test -- --reporter=verbose
```

### Electron integration test (optional)

```bash
cd electron
PYTHON_PATH=/path/to/python npm test -- --reporter=verbose main/integration.test.ts
```

## Build and run

### Build

```bash
cd electron
npm run build
```

### Run in development mode

```bash
cd electron
npm run dev
```

---

© 2026 Matthew Pharr. All rights reserved. This code is a work in progress and is not licensed for any use, modification, or distribution without my explicit written permission.
