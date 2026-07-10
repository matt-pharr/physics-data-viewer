# pdv-python

Kernel-side support package for **PDV (Physics Data Viewer)**. It implements the
PDV comm protocol and the persistent data structures (`PDVTree`, `PDVScript`,
`PDVFile`, `PDVNote`, `PDVNamelist`, …) that run inside a Jupyter kernel and back
the PDV desktop application's Tree.

This package is installed into each project's kernel environment; it is not meant
to be used standalone. See the [PDV documentation](https://matt-pharr.github.io/physics-data-viewer/)
for the full architecture and API reference.

## Installation

```bash
pip install pdv-python            # core (ipykernel, numpy, matplotlib, xxhash)
pip install "pdv-python[data]"    # + pandas
pip install "pdv-python[namelist]"# + f90nml, tomli-w (Fortran / TOML namelists)
pip install "pdv-python[xarray]"  # + xarray (Dataset serialization)
pip install "pdv-python[copy]"    # + reflink-copy (copy-on-write file cloning)
```

## Development

```bash
pip install -e "pdv-python[dev]"  # installs every optional dependency
cd pdv-python && pytest tests/ -q
```

The `dev` extra is a superset of all optional features, so the full test suite
runs with no silently-skipped cases. Before merging a change that touches this
package, run the dependency-resolution sweep:

```bash
pdv-python/scripts/sweep-deps.sh
```

## License

MIT — see [`LICENSE.md`](../LICENSE.md) at the repository root.
