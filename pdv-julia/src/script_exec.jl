# script_exec.jl — Script loading/execution and lib-module management.
#
# Port of the execution half of pdv/tree.py (PDVScript.run) plus the Julia
# analog of Python's sys.path wiring for module libs:
#
# - Lib files (`PDVLib`) are `include`d into `Main`; the module objects they
#   define are recorded in a registry so script modules can `using` them.
# - Scripts run in a *fresh anonymous module* every time (no import cache),
#   with every registered lib module's exports brought into scope — this is
#   what lets `solve.jl` reference `PendulumSolution` unqualified.

# alias => [module names loaded from that alias's libs]
const _LIB_MODULES = Dict{String,Vector{Symbol}}()
# lib file path (realpath) => module name, for reloads
const _LIB_FILE_MODULES = Dict{String,Symbol}()

"""
    load_lib_file!(lib_path; alias="") -> Union{Symbol,Nothing}

`include` a PDVLib file into `Main` and record the module it defines (matched
by the file's stem, e.g. `NPendulum.jl` → `Main.NPendulum`). Re-including an
already-loaded file replaces the module — the Julia analog of
`importlib.reload`. Returns the module's name, or `nothing` when the file
defines no module of the expected name (its top-level code still ran).
"""
function load_lib_file!(lib_path::AbstractString; alias::AbstractString="")
    real = ispath(lib_path) ? realpath(lib_path) : String(lib_path)
    Base.include(Main, real)
    stem = Symbol(first(splitext(basename(real))))
    mod_name = nothing
    if isdefined(Main, stem) && getfield(Main, stem) isa Module
        mod_name = stem
        _LIB_FILE_MODULES[real] = stem
        if !isempty(alias)
            mods = get!(_LIB_MODULES, String(alias), Symbol[])
            stem in mods || push!(mods, stem)
        end
    end
    return mod_name
end

"""Forget all recorded lib modules (used in tests and on project unload)."""
clear_lib_modules!() = (empty!(_LIB_MODULES); empty!(_LIB_FILE_MODULES); nothing)

# All lib module names currently registered (deduped, insertion order lost).
function _all_lib_module_names()::Vector{Symbol}
    seen = Symbol[]
    for mods in values(_LIB_MODULES)
        for m in mods
            m in seen || push!(seen, m)
        end
    end
    return seen
end

# ---------------------------------------------------------------------------
# Script parameter extraction (Meta.parseall — no execution)
# ---------------------------------------------------------------------------

# Map a Julia type annotation to the renderer's coarse type vocabulary.
function _param_type_label(ann)::String
    ann === nothing && return "any"
    s = string(ann)
    occursin(r"^(Int|Int8|Int16|Int32|Int64|UInt\d*|Integer)$", s) && return "int"
    occursin(r"^(Float16|Float32|Float64|AbstractFloat|Real)$", s) && return "float"
    occursin(r"^(String|AbstractString)$", s) && return "str"
    s == "Bool" && return "bool"
    return s
end

# Recover a literal default value; non-literals fall back to source text.
function _param_default(expr)
    expr === nothing && return nothing
    (expr isa Number || expr isa String || expr isa Bool) && return expr
    expr isa QuoteNode && return string(expr.value)
    if expr isa Expr && expr.head == :call && length(expr.args) == 2 &&
       expr.args[1] === :- && expr.args[2] isa Number
        return -expr.args[2]
    end
    return string(expr)
end

# Walk a parsed expression tree looking for `function run(...)` definitions.
function _find_run_signature(expr)
    if expr isa Expr
        if expr.head in (:function, :(=)) && !isempty(expr.args)
            sig = expr.args[1]
            if sig isa Expr && sig.head == :call && !isempty(sig.args) && sig.args[1] === :run
                return sig
            end
            # `function run(...)::T` wraps the call in a :(::)
            if sig isa Expr && sig.head == :(::) && !isempty(sig.args)
                inner = sig.args[1]
                if inner isa Expr && inner.head == :call && !isempty(inner.args) &&
                   inner.args[1] === :run
                    return inner
                end
            end
        end
        for arg in expr.args
            found = _find_run_signature(arg)
            found !== nothing && return found
        end
    end
    return nothing
end

"""
    extract_script_params(file_path) -> Vector{Dict}

Extract the user-facing keyword parameters of a script's `run()` function by
parsing the source (never executing it). Returns an empty list when the file
is missing, unparsable, or defines no `run()`.

Julia scripts follow `run(pdv_tree; kwargs...)`; only keyword parameters are
user-facing (positional parameters cannot be supplied by name at invocation).
"""
function extract_script_params(file_path::AbstractString)::Vector{Dict{String,Any}}
    source = try
        read(file_path, String)
    catch
        return Dict{String,Any}[]
    end
    parsed = try
        Meta.parseall(source; filename=String(file_path))
    catch
        return Dict{String,Any}[]
    end
    sig = _find_run_signature(parsed)
    sig === nothing && return Dict{String,Any}[]

    params = Dict{String,Any}[]
    for arg in sig.args[2:end]
        (arg isa Expr && arg.head == :parameters) || continue
        for kw in arg.args
            local name_expr, default
            if kw isa Expr && kw.head == :kw
                name_expr, default = kw.args[1], kw.args[2]
            elseif kw isa Symbol || (kw isa Expr && kw.head == :(::))
                name_expr, default = kw, nothing
            else
                continue  # kwargs... splat
            end
            local pname, ann
            if name_expr isa Expr && name_expr.head == :(::)
                pname, ann = name_expr.args[1], name_expr.args[2]
            else
                pname, ann = name_expr, nothing
            end
            pname isa Symbol || continue
            push!(params, Dict{String,Any}(
                "name" => string(pname),
                "type" => _param_type_label(ann),
                "default" => _param_default(default),
                "required" => default === nothing,
            ))
        end
    end
    return params
end

# ---------------------------------------------------------------------------
# Script execution
# ---------------------------------------------------------------------------

"""
    check_module_dependencies(script, tree)

Verify that the parent module's declared dependencies are resolvable in the
active Julia environment. Throws `PDVScriptError` listing missing packages.
Dependencies whose `marker` mentions "optional" or "stdlib" are skipped.
"""
function check_module_dependencies(script::PDVScript, tree::AbstractPDVTree)
    isempty(script.module_id) && return
    parent_module = nothing
    for value in values(tree.data)
        if value isa PDVModule && value.module_id == script.module_id
            parent_module = value
            break
        end
    end
    (parent_module === nothing || isempty(parent_module.dependencies)) && return

    missing_deps = String[]
    for dep in parent_module.dependencies
        name = get(dep, "name", "")
        marker = lowercase(string(get(dep, "marker", "")))
        isempty(name) && continue
        (occursin("optional", marker) || occursin("stdlib", marker)) && continue
        if Base.identify_package(name) === nothing
            push!(missing_deps, name)
        end
    end
    if !isempty(missing_deps)
        throw(PDVScriptError(
            "Module '$(parent_module.name)' requires packages not installed in " *
            "the active environment: $(join(missing_deps, ", "))"))
    end
    nothing
end

"""
    script_run(script::PDVScript, tree=nothing; kwargs...) -> Any

Load and execute the script, calling its `run(pdv_tree; kwargs...)` function.
The file is loaded fresh into an anonymous module on every call so in-place
edits are always reflected, with every registered lib module's exports
brought into scope.
"""
function script_run(script::PDVScript, tree::Union{Nothing,AbstractPDVTree}=nothing;
                    kwargs...)
    if tree === nothing
        tree = get_pdv_tree()
        tree === nothing && throw(PDVScriptError("PDVTree is not initialized"))
    end

    file_path = resolve_path(script, tree.working_dir)
    isfile(file_path) || throw(PDVScriptError("Script file not found: $file_path"))

    check_module_dependencies(script, tree)

    mod = Module(gensym("PDVScript"))
    # Make PDVKernel itself and every loaded lib module's exports visible.
    Core.eval(mod, :(const PDVKernel = $(@__MODULE__)))
    for lib_name in _all_lib_module_names()
        isdefined(Main, lib_name) || continue
        try
            Core.eval(mod, Expr(:using, Expr(:., :Main, lib_name)))
        catch err
            @warn "Could not bring lib module $(lib_name) into script scope" exception = err
        end
    end

    try
        Base.include(mod, file_path)
    catch err
        throw(PDVScriptError(
            "Cannot load script '$(script.filename)': $(sprint(showerror, err))"))
    end

    isdefined(mod, :run) || throw(PDVScriptError(
        "Script '$(script.filename)' does not define a run() function"))

    try
        return Base.invokelatest(mod.run, tree; kwargs...)
    catch err
        throw(PDVScriptError(
            "Script '$(script.filename)' raised during run(): $(sprint(showerror, err))"))
    end
end

"""
    run_script(tree, script_path; kwargs...) -> Any

Execute a script stored in the tree: resolves `script_path` to a `PDVScript`
node and calls [`script_run`](@ref).
"""
function run_script(tree::AbstractPDVTree, script_path::AbstractString; kwargs...)
    node = try
        tree[script_path]
    catch e
        e isa PDVKeyError && throw(PDVKeyError(String(script_path)))
        rethrow()
    end
    node isa PDVScript || throw(ArgumentError(
        "Node at '$script_path' is not a PDVScript (got $(typeof(node)))"))
    return script_run(node, tree; kwargs...)
end

"""
    run_tree_script(tree, script_path; kwargs...) -> Any

Entry point used by the app's `script:run` IPC handler (see
`ipc-register-tree-namespace-script.ts`). Identical to [`run_script`](@ref).
"""
run_tree_script(tree::AbstractPDVTree, script_path::AbstractString; kwargs...) =
    run_script(tree, script_path; kwargs...)
