# Physics Data Viewer

This repository hosts the foundations of a modern physics data analysis platform. The application is designed for domain experts to explore nested data structures, run Python analysis, and extend functionality through a module (plugin) system.

For the complete vision and roadmap, see [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md). This initial phase delivers:

- Python package scaffolding using a `src/` layout
- A module system foundation with manifest parsing and filesystem discovery
- `ShowablePlottable` protocols for custom data types that can render text (`show`) and visualizations (`plot`)
- Example modules and data types demonstrating expected patterns
- Pytest-based test infrastructure

## Getting Started

1. Install dependencies (including testing extras):

```bash
pip install -e .[test]
```

2. Run the test suite:

```bash
pytest
```

3. Explore the examples:
   - `examples/minimal_module/` shows the simplest module with a manifest and `Module` class.
   - `examples/custom_types_example/` contains reference implementations of `ShowablePlottable` data types.

## Module Manifests

Modules reside in a `modules/` directory. Each module folder requires a manifest file (`manifest.yaml`, `manifest.yml`, or `manifest.json`) containing:

- `name`, `version`, `author` (required)
- `description` (optional)
- `dependencies` list (optional)

The loader in `platform.modules.loader` discovers manifest files and imports the corresponding `Module` class from `module.py`.
