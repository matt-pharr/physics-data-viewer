# pdv-julia (PDVKernel.jl)

The Julia kernel support package for [PDV (Physics Data Viewer)](https://github.com/matt-pharr/physics-data-viewer) — the Julia counterpart of `pdv-python`. It implements the kernel side of the PDV comm protocol on top of [IJulia](https://github.com/JuliaLang/IJulia.jl): the persistent `pdv_tree` data hierarchy, project save/load, script execution, module/lib loading, the namelist editor backend, and the read-only query server.

The authoritative design specification is `ARCHITECTURE.md` at the repository root; §5.14 documents this package and its deliberate Julia-vs-Python translations. Current bugs and parity gaps are tracked in [`JULIA_KNOWN_ISSUES.md`](../JULIA_KNOWN_ISSUES.md).

## Installation

Requires Julia ≥ 1.10 with IJulia installed in the environment PDV will use:

```julia
using Pkg
Pkg.add("IJulia")
Pkg.develop(path="/path/to/physics-data-viewer/pdv-julia")
```

PDV probes the selected Julia with `using PDVKernel; println(PDVKernel.VERSION)`; the version must match the app version (the unified version rule).

## Using PDV from Julia

Inside a PDV Julia session, `pdv_tree` is the live project tree (a `const` in `Main` — it cannot be reassigned):

```julia
pdv_tree["data.waveform"] = collect(range(0, 1, length=1024))   # ndarray node (.npy on save)
pdv_tree["config"] = Dict("mode" => "fast", "n" => 3)            # inline mapping
pdv_tree["data.waveform"]                                        # dot-path access
```

Scripts follow the fixed PDV contract with keyword parameters:

```julia
function run(pdv_tree::AbstractDict; amplitude::Float64 = 1.0)
    # ... analysis ...
    return Dict("result" => amplitude)
end
```

Modules extend PDV via multiple dispatch instead of decorators:

```julia
import PDVKernel: pdv_handle, pdv_preview, PDVTree

pdv_preview(sol::MySolution) = "solution ($(length(sol.t)) steps)"
function pdv_handle(sol::MySolution, path::String, tree::PDVTree)
    # double-click handler: plot, print, open a window, ...
end
```

Custom persistence uses the same protocol as methods (`pdv_format`, `pdv_serialize`, `pdv_deserialize`, optional `pdv_digest`), or `PDVKernel.register_serializer` for types you don't own.

## Tests

```bash
julia --project=pdv-julia -e 'using Pkg; Pkg.test()'
```

The suite runs without a kernel (the comm transport is stubbed). The cross-boundary integration suite lives in `electron/main/integration-julia.test.ts` (gated on `JULIA_PATH`), and `electron/e2e/julia-smoke.spec.ts` drives the full app GUI.
