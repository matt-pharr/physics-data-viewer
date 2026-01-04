# Module Development Guide

Modules can extend the platform by contributing data, behaviors, and **custom UI panels** without writing JavaScript. This guide summarizes the Python APIs introduced in PR #11.

## Lifecycle

1. Define a manifest (`manifest.yaml`) with `name`, `version`, and `author`.
2. Implement a `Module` class that subclasses `platform.modules.base.BaseModule`.
3. Use the provided `ModuleContext` (attached as `self.context`) during `initialize` to register UI and data.
4. Perform cleanup in `shutdown` (UI panels registered through the context can be cleaned automatically via `context.cleanup()`).

## Registering UI Panels

Use `ModuleContext.register_panel` to expose a UI panel rendered in the Electron app:

```python
from platform.modules.base import BaseModule
from platform.modules.context import ModuleContext


class Module(BaseModule):
    def initialize(self, context: ModuleContext | None = None):
        self.context = context
        if context:
            context.register_panel(
                title="Diagnostics",
                description="Live metrics from this module",
                render=self.render_panel,  # returns a dict payload
                panel_id="my_module:diagnostics",  # optional but should be stable
            )
        self.mark_initialized()

    def render_panel(self) -> dict:
        return {
            "sections": [
                {
                    "title": "Health",
                    "items": [
                        {"label": "Status", "value": "ok"},
                        {"label": "Tasks", "value": "3"},
                    ],
                }
            ]
        }
```

Panels are fetched from `/modules/ui-panels` and can be refreshed via `/modules/ui-panels/{panel_id}/refresh`.

## Exposing Data to the ProjectTree

Modules can publish lazy data (e.g., xarray/HDF5-backed nodes) into the global `ProjectTree`:

```python
def initialize(self, context: ModuleContext | None = None):
    if context:
        context.expose_lazy_data(
            ["my_module", "datasets", "spectra"],
            loader=lambda: load_heavy_dataset(),
            preview="spectra: 42 rows",
            metadata={"kind": "hdf5"},
        )
    self.mark_initialized()
```

`preview` and `metadata` help the data viewer show lightweight summaries without materializing the entire dataset.

## Accessing Application State and REPL

- `context.get_session_state(session_id)` returns a copy of a session’s state.
- `context.set_project_value(path, value)` writes concrete data into the `ProjectTree`.
- `context.update_session_value(session_id, path, value)` updates nested session state (emits state change notifications).
- `context.execute_in_repl(code, session_id=None, timeout=5.0)` executes Python in the shared REPL (requires the backend executor).

## Module Communication & Events

PR #12 adds a lightweight event bus for inter-module communication:

- `context.publish_event(event_type, payload, metadata=None)` broadcasts an event.
- `context.subscribe_event(event_type, callback, predicate=None)` listens for events; use `predicate` to filter.
- `context.get_dependency(name)` returns a declared module dependency (enforced via the manifest).
- ProjectTree and session state updates automatically emit `project_tree` and `session_state` events when the context is attached to the shared `EventSystem`.

See `examples/example_event_module` for a minimal publish/subscribe module.

## Reference Module

`examples/example_gui_module` demonstrates:

- Registering a UI panel.
- Publishing a lazy dataset into the `ProjectTree`.
- Cleaning up panel registrations during shutdown.

Use it as a template when building your own modules.
