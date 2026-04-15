# API Reference

This reference documents the Python surface exposed by the `pdv_kernel`
package — everything a user touches from a code cell, a script, or a
module library.

## Two primary objects

Every PDV kernel has two names injected into the user namespace at startup:

| Name        | What it is                                      | Reference                          |
|-------------|--------------------------------------------------|------------------------------------|
| `pdv_tree`  | The live project data tree (a `dict` subclass). | [The Tree](tree.md)                |
| `pdv`       | An app object for session-level operations.     | [The App Object](app.md)           |

Most user code reads and writes `pdv_tree` to store results, attach files,
register scripts, and build up a project hierarchy. The nodes you assign
into the tree are instances of the [tree node types](nodes.md).

Module developers additionally use `pdv.handle` and `pdv.register_serializer`
to teach PDV about their own classes — see the [Module API](module-api.md).

## What is not documented here

Only the symbols described on these pages are public API. Everything else
in `pdv_kernel` — `comms`, `handlers`, `namespace` internals, `serialization`
readers/writers, project load/save machinery — is implementation detail and
may change without notice. Importing from those modules directly is not
supported.

## Utilities

::: pdv_kernel.log
    options:
      show_root_heading: true
      show_source: false

### `pdv_kernel.__version__`

String version of the installed `pdv-python` package. Matches the Electron
app version it was built against; mismatch is detected at kernel startup
and surfaces as a [`PDVVersionError`](errors.md).
