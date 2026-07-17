# default_handlers.jl — Built-in double-click handlers for common types.
#
# Port of pdv/default_handlers.py. Double-clicking a tree node whose value is
# a numeric Vector/Matrix, a Makie Figure, or a DataFrame does something
# sensible without the user writing a module.
#
# Registration is **lazy**, mirroring Python's sys.modules gate:
# `register_default_handlers!()` runs from every registry lookup
# (`has_handler_for` / `dispatch_handler`) but short-circuits on a
# loaded-module count latch, so the per-lookup cost is one integer compare.
# A tree value can only *be* a Makie Figure or DataFrame if its library is
# already loaded, so the gate loses nothing — and PDVKernel never has to
# depend on (or import) any plotting package.
#
# Two registration mechanisms, chosen per type:
# - Base types (numeric AbstractVector/AbstractMatrix) get ordinary
#   `pdv_handle` methods at package load; multiple dispatch means a user's
#   more-specific method automatically wins. The body runtime-gates on a
#   Makie backend and prints a `[PDV]` notice when none is loaded.
# - Foreign types (Makie.Figure, FigureAxisPlot, DataFrame) are registered
#   through `register_handler` once their library appears in
#   `Base.loaded_modules` — the types don't exist at package load time.
#   Defaults never overwrite an existing registration (user handlers win).
#
# Makie figures additionally get a lazy `pdv_digest` method that hashes the
# rendered pixels (`colorbuffer`). Unlike a structural walk of the live
# object graph (display state, weak refs), the rendered image is a
# content-faithful digest that is stable across a save/load round trip, so
# reopened figure-bearing projects don't show a spurious checksum-mismatch
# marker.

# Loaded-module count at the last lazy scan. Any package load changes the
# count, which is the only event that can make a new default registrable.
const _defaults_seen_module_count = Ref(0)

# Libraries whose defaults have been registered (latch, like Python's
# _lazy_done). Reset by clear_handlers! via _reset_default_handlers!.
const _defaults_done = Set{Symbol}()

"""
    register_default_handlers!()

Register built-in handlers for every supported library that is already
loaded. Called from the handler-registry lookups rather than eagerly at
bootstrap; cheap (one integer compare) unless a new module was loaded since
the previous call. Never overwrites an existing registration.
"""
function register_default_handlers!()
    n = length(Base.loaded_modules)
    n == _defaults_seen_module_count[] && return nothing
    _defaults_seen_module_count[] = n

    if !(:Makie in _defaults_done)
        mk = loaded_module(:Makie)
        if mk !== nothing
            push!(_defaults_done, :Makie)
            _register_makie_defaults!(mk)
        end
    end
    if !(:DataFrames in _defaults_done)
        df = loaded_module(:DataFrames)
        if df !== nothing
            push!(_defaults_done, :DataFrames)
            _register_dataframes_defaults!(df)
        end
    end
    nothing
end

"""Forget the lazy-registration state (tests; called by clear_handlers!)."""
function _reset_default_handlers!()
    empty!(_defaults_done)
    _defaults_seen_module_count[] = 0
    nothing
end

# Register `func` for `T` only when nothing is registered yet — a
# user-registered handler for the same type always wins over a default.
function _register_default(func::Function, T::Type)
    haskey(_HANDLER_REGISTRY, T) && return nothing
    _HANDLER_REGISTRY[T] = HandlerEntry(T, func, fully_qualified_type_name(T))
    nothing
end

function _register_makie_defaults!(mk::Module)
    # Resilient display: a reloaded figure can exist with Makie loaded but no
    # backend activated (nothing to render with) — tell the user what to do
    # instead of surfacing an opaque handler error.
    show_fig = (obj, path, tree) -> try
        Base.invokelatest(display, obj)
    catch err
        println("[PDV] Cannot display '$path': $(sprint(showerror, err))\n" *
                "[PDV] Load a Makie backend (e.g. `using CairoMakie`) and try again.")
    end
    isdefined(mk, :Figure) && _register_default(show_fig, getproperty(mk, :Figure))
    isdefined(mk, :FigureAxisPlot) &&
        _register_default(show_fig, getproperty(mk, :FigureAxisPlot))

    # Rendered-pixels digest for figures (see module docstring). Evaluated
    # lazily because the Figure type doesn't exist at package load time.
    if isdefined(mk, :Figure)
        FigT = getproperty(mk, :Figure)
        if !hasmethod(pdv_digest, Tuple{FigT})
            Core.eval(@__MODULE__,
                      :(pdv_digest(fig::$FigT) = _makie_figure_digest(fig)))
        end
    end
    nothing
end

function _register_dataframes_defaults!(df::Module)
    isdefined(df, :DataFrame) || return nothing
    _register_default((obj, path, tree) -> Base.invokelatest(display, obj),
                      getproperty(df, :DataFrame))
    nothing
end

"""
    _makie_figure_digest(fig) -> Vector{UInt8}

Digest payload for a Makie figure: the rendered image bytes prefixed with
the pixel dimensions. Rendering is deterministic for identical figure
content, so the digest survives a save/load round trip (unlike the live
object graph). Errors propagate — the checksum walk treats a failed
`pdv_digest` as "no digest" and falls back to its own scheme.
"""
function _makie_figure_digest(fig)::Vector{UInt8}
    mk = loaded_module(:Makie)
    mk === nothing && error("Makie is not loaded")
    colorbuffer = getproperty(mk, :colorbuffer)
    img = try
        Base.invokelatest(colorbuffer, fig)
    catch err
        # A freshly-reloaded project has Makie (the figure's own package)
        # loaded but no backend activated — rendering needs one. Pull in
        # CairoMakie (the standard in-memory renderer) and retry once, so
        # post-load checksums keep matching their save-time values. If it
        # isn't installed the original error propagates and the checksum
        # walk falls back to its own scheme.
        loaded_module(:CairoMakie) === nothing || rethrow()
        Base.require(Main, :CairoMakie)
        Base.invokelatest(colorbuffer, fig)
    end
    header = collect(reinterpret(UInt8, [htol(UInt64(size(img, 1))),
                                         htol(UInt64(size(img, 2)))]))
    return vcat(header, collect(reinterpret(UInt8, vec(img))))
end

# ---------------------------------------------------------------------------
# Numeric-array defaults (Base types: plain pdv_handle methods)
# ---------------------------------------------------------------------------

# Run `draw(makie_module)` and display what it returns, or print a `[PDV]`
# notice — a raised exception would reach the renderer as an opaque
# internal.error (same contract as Python's _plot_or_notice). Function-first
# so call sites can use do-block syntax.
function _plot_with_makie(draw::Function, path::String)
    mk = loaded_module(:Makie)
    if mk === nothing
        println("[PDV] Cannot plot '$path': no Makie backend is loaded. " *
                "Run e.g. `using CairoMakie` first.")
        return nothing
    end
    try
        result = Base.invokelatest(draw, mk)
        Base.invokelatest(display, result)
    catch err
        println("[PDV] Cannot plot '$path': $(sprint(showerror, err))")
    end
    nothing
end

function pdv_handle(obj::AbstractVector{<:Real}, path::String, tree::PDVTree)
    _plot_with_makie(path) do mk
        Base.invokelatest(getproperty(mk, :lines), obj;
                          axis=(title=path,))
    end
    nothing
end

function pdv_handle(obj::AbstractMatrix{<:Real}, path::String, tree::PDVTree)
    _plot_with_makie(path) do mk
        fig, ax, hm = Base.invokelatest(getproperty(mk, :heatmap), obj;
                                        axis=(title=path,))
        Base.invokelatest(getproperty(mk, :Colorbar), fig[1, 2], hm)
        fig
    end
    nothing
end

# 0-D and ≥3-D numeric arrays: a friendly notice with `dispatched: true`,
# matching pdv-python's "[PDV] Cannot plot N-D ndarray" (second review —
# without this the dispatch fell through to `dispatched: false` + error,
# a kernel-visible response divergence between the backends).
function pdv_handle(obj::AbstractArray{<:Real}, path::String, tree::PDVTree)
    println("[PDV] Cannot plot $(ndims(obj))-D ndarray (size=$(size(obj))); " *
            "default handler supports 1D and 2D only.")
    nothing
end
