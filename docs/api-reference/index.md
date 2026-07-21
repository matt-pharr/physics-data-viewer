# API Reference

This reference documents the Python surface exposed by the `pdv`
package — everything a user touches from a code cell, a script, or a
module library.

## Two primary names

User code works with two names:

| Name        | What it is                                                       | Reference                          |
|-------------|-----------------------------------------------------------------|------------------------------------|
| `pdv_tree`  | The live project data tree (a `dict` subclass). **Injected** and protected at kernel startup. | [The Tree](tree.md)   |
| `pdv`       | The `pdv` **package** itself, exposing session-level functions.  | [The App Object](app.md)           |

`pdv_tree` is the only injected binding — the kernel installs it into the
namespace and protects it from reassignment. `pdv` is not a special object:
it is the importable `pdv` package (already importable because `pdv-python`
is installed), and its session-level operations (`pdv.save()`, `pdv.help()`,
`pdv.add_file()`, …) are module-level functions on that package.

Most user code reads and writes `pdv_tree` to store results, attach files,
register scripts, and build up a project hierarchy. The nodes you assign
into the tree are instances of the [tree node types](nodes.md).

Module developers additionally use `pdv.handle` and `pdv.register_serializer`
to teach PDV about their own classes — see the [Module API](module-api.md).

## Julia sessions

Julia sessions expose the same surface through the `PDVKernel` package —
`pdv_tree` works identically (with 1-based sequence dot-paths), and the
session-level operations live on `PDVKernel` instead of `pdv`. See the
[Julia API reference](julia.md), generated from PDVKernel's docstrings.

## What is not documented here

Only the symbols described on these pages are public API. Everything else
in `pdv` — `comms`, `handlers`, `namespace` internals, `serialization`
readers/writers, project load/save machinery — is implementation detail and
may change without notice. Importing from those modules directly is not
supported.

## Utilities

::: pdv.log
    options:
      show_root_heading: true
      show_source: false

### `pdv.__version__`

String version of the installed `pdv-python` package. Matches the Electron
app version it was built against; mismatch is detected at kernel startup
and surfaces as a [`PDVVersionError`](errors.md).
