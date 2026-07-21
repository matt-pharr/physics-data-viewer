# generate-api-docs.jl — Render PDVKernel's public-API docstrings to Markdown.
#
# The docs site (MkDocs Material) autodocs the Python API with
# mkdocstrings[python], but no Julia handler exists for mkdocstrings and
# Documenter.jl's Markdown backend is unmaintained — so this script is the
# Julia analog: it pulls the docstrings out of the live PDVKernel module via
# `Base.Docs` and writes `docs/api-reference/julia.md` as a committed,
# generated page that the existing docs pipeline builds unchanged (the CI
# runner needs no Julia install).
#
# Usage (from the repo root, any Julia with pdv-julia's deps available):
#
#     julia --project=pdv-julia pdv-julia/scripts/generate-api-docs.jl
#
# Re-run whenever a public docstring in pdv-julia/src changes, and commit the
# regenerated file. Bindings listed below that lack a docstring are reported
# as warnings and rendered with a TODO marker so gaps are visible in review.

import Markdown

# Load PDVKernel from the source tree the script sits in, regardless of the
# active environment's dev-install state.
import Pkg
Pkg.activate(dirname(@__DIR__); io=devnull)
Pkg.instantiate(; io=devnull)
import PDVKernel

const REPO_ROOT = dirname(dirname(@__DIR__))
const OUT_PATH = joinpath(REPO_ROOT, "docs", "api-reference", "julia.md")

"""
    docstring_markdown(sym) -> Union{String,Nothing}

Render the docstring attached to `PDVKernel.<sym>` as plain Markdown, or
`nothing` when the binding has no documentation.
"""
function docstring_markdown(sym::Symbol)
    binding = Base.Docs.Binding(PDVKernel, sym)
    # Consult the module's doc metadata directly: `Base.Docs.doc` falls back
    # to a synthesized "No documentation found" page, which we must not
    # publish.
    haskey(Base.Docs.meta(PDVKernel), binding) || return nothing
    md = Base.Docs.doc(binding)
    text = Markdown.plain(md)
    # Docstrings use Documenter-style `[`name`](@ref)` cross-references;
    # MkDocs would render those as broken links. Downgrade them to plain
    # code spans (covers both `[`x`](@ref)` and `[text](@ref target)`).
    text = replace(text, r"\[(`[^`]+`)\]\(@ref[^)]*\)" => s"\1")
    text = replace(text, r"\[([^\]]+)\]\(@ref[^)]*\)" => s"\1")
    return strip(text) * "\n"
end

# ---------------------------------------------------------------------------
# Page structure: (section title, section prose, bindings).
#
# Mirrors the Python API pages (tree.md / nodes.md / app.md / module-api.md /
# errors.md) so the two languages read side by side.
# ---------------------------------------------------------------------------

const SECTIONS = [
    (
        "The Tree (`pdv_tree`)",
        """
        `pdv_tree` is the live project data tree, injected into `Main` as a
        `const` at kernel startup (Julia's `const` rejection of rebinding
        replaces Python's protected namespace). It behaves like a `Dict`
        with dot-path access — `pdv_tree["results.run_01.temperature"]`
        resolves through intermediate dicts, creating them on write.
        Sequence indices in dot-paths are **1-based** (`pdv_tree["xs.1"]`),
        matching Julia convention; negative indices count from the end.
        """,
        [:PDVTree],
    ),
    (
        "Tree Node Types",
        """
        Values assigned into the tree are either plain data (numbers,
        strings, arrays, `Dict`s, arbitrary serializable structs) or
        instances of the node types below, which carry file-backed or
        app-visible behavior.
        """,
        [:PDVScript, :PDVFile, :PDVNote, :PDVGui, :PDVNamelist, :PDVModule, :PDVLib],
    ),
    (
        "App-Level Operations",
        """
        The Julia analog of the `pdv` package's module-level functions:
        session-level operations that act on the running PDV application,
        called as `PDVKernel.<name>(...)` from any code cell.
        """,
        [:working_dir, :save, :save_project, :save_project_as, :open_project,
         :install, :remove, :update, :add_file, :new_note, :help, :log],
    ),
    (
        "Protocol Generic Functions (Module API)",
        """
        Where Python modules use decorators (`@pdv.handle`) and dunder
        methods (`__pdv_format__`, …), Julia modules extend **generic
        functions** with methods for their own types — multiple dispatch is
        the extension mechanism. Define a method and PDV picks it up; user
        methods always win over the built-in defaults by dispatch
        specificity.
        """,
        [:pdv_handle, :pdv_preview, :pdv_format, :pdv_serialize,
         :pdv_deserialize, :pdv_digest, :register_handler, :register_serializer],
    ),
    (
        "Script Execution",
        """
        PDV scripts define `run(pdv_tree; kwargs...)`; the app invokes them
        through `run_tree_script`, which is also callable directly from a
        cell.
        """,
        [:run_tree_script],
    ),
    (
        "Exceptions",
        """
        PDV error types, mirroring `pdv-python`'s exception hierarchy.
        """,
        [:PDVException, :PDVPathError, :PDVKeyError, :PDVProtectedNameError,
         :PDVSerializationError, :PDVScriptError, :PDVVersionError],
    ),
]

const HEADER = """
<!-- GENERATED FILE — do not edit by hand.
     Regenerate with:
       julia --project=pdv-julia pdv-julia/scripts/generate-api-docs.jl
     and commit the result. -->

# Julia API (`PDVKernel`)

This reference documents the Julia surface exposed by the `PDVKernel`
package — the [Julia counterpart](../developer/architecture.md) of
`pdv-python`, with full protocol parity. Everything here is extracted from
the package's docstrings.

Two primary names, as in Python:

| Name        | What it is                                                                                     | Reference |
|-------------|------------------------------------------------------------------------------------------------|-----------|
| `pdv_tree`  | The live project data tree (dict-like). **Injected** into `Main` as a `const` at kernel startup. | [The Tree](#the-tree-pdv_tree) |
| `PDVKernel` | The package itself, exposing session-level functions.                                            | [App-Level Operations](#app-level-operations) |

The deliberate Julia translations from the Python API: multiple-dispatch
generic functions replace decorators and dunder protocols, `.jls`
`Serialization` replaces pickle, sequence dot-paths are 1-based, and
per-project environments are Pkg-managed (`Project.toml`/`Manifest.toml`)
rather than uv-managed.
"""

function main()
    missing_docs = String[]
    io = IOBuffer()
    print(io, HEADER)

    for (title, prose, syms) in SECTIONS
        println(io, "\n## ", title, "\n")
        for line in split(strip(prose), '\n')
            println(io, strip(line))
        end
        for sym in syms
            println(io, "\n### `PDVKernel.", sym, "`\n")
            doc = docstring_markdown(sym)
            if doc === nothing
                push!(missing_docs, String(sym))
                println(io, "*(docstring missing — TODO)*")
            else
                print(io, doc)
            end
        end
    end

    mkpath(dirname(OUT_PATH))
    write(OUT_PATH, String(take!(io)))
    rel = relpath(OUT_PATH, REPO_ROOT)
    println("wrote $rel")
    if !isempty(missing_docs)
        @warn "bindings without docstrings (rendered as TODO)" missing_docs
    end
end

main()
