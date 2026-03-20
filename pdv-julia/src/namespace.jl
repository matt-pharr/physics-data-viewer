# PDVKernel namespace — PDVApp and namespace snapshot.
#
# Provides:
# - PDVApp: the `pdv` object injected into the namespace.
# - pdv_namespace(): returns a snapshot of Main bindings for the Namespace panel.
#
# Note: In Julia, namespace protection is achieved via `const` bindings
# in Main, which error on reassignment. No custom dict wrapper is needed.

"""
    PDVApp

The `pdv` object injected into the kernel namespace.
Exposes `pdv.save()`, `pdv.help()` to users.
"""
mutable struct PDVApp
    handle::Any  # Will be set to the pdv_handle decorator
end

PDVApp() = PDVApp(nothing)

function Base.show(io::IO, ::PDVApp)
    print(io, "<PDV app object — type pdv.help() for usage>")
end

"""
    pdv_save(app::PDVApp)

Trigger a project save. Equivalent to File -> Save in the UI.
"""
function pdv_save(app::PDVApp)
    try
        send_message("pdv.project.save", Dict{String,Any}())
    catch
        println("PDV: No comm channel open. Cannot trigger save.")
    end
end

"""
    pdv_help(app::PDVApp; topic=nothing)

Print PDV help.
"""
function pdv_help(app::PDVApp; topic::Union{String,Nothing}=nothing)
    if topic === nothing
        println("""PDV Help
--------
  pdv_tree          — the project data tree (dict-like)
  pdv_tree["path"]  — access or set a node by dot-path
  run_tree_script(pdv_tree, "path") — run a script node
  pdv_save(pdv)     — save the project
  pdv_help(pdv)     — this help message""")
    else
        println("PDV help for topic '$topic' is not yet implemented.")
    end
end

"""
    pdv_namespace(ns::Module; kwargs...) -> Dict

Return a snapshot of the kernel namespace for the Namespace panel.
"""
function pdv_namespace(mod::Module=Main;
                       include_private::Bool=false,
                       include_modules::Bool=false,
                       include_callables::Bool=false)::Dict{String,Any}
    _INTERNAL = Set(["pdv_tree", "pdv", "ans"])

    result = Dict{String,Any}()

    for name_sym in names(mod; all=true)
        name = string(name_sym)

        # Skip internal names
        name in _INTERNAL && continue
        startswith(name, "_pdv") && continue
        startswith(name, "#") && continue
        name == string(mod) && continue

        # Skip private names unless requested
        if !include_private && startswith(name, "_")
            continue
        end

        if !isdefined(mod, name_sym)
            continue
        end

        value = getfield(mod, name_sym)

        # Skip modules unless requested
        if !include_modules && value isa Module
            continue
        end

        # Skip callables unless requested
        if !include_callables && (value isa Function || value isa Type)
            continue
        end

        try
            kind = detect_kind(value)
            preview = node_preview(value, kind)
            descriptor = Dict{String,Any}("type" => kind, "preview" => preview)

            # Add extra metadata for arrays
            if value isa AbstractArray
                descriptor["shape"] = collect(size(value))
                descriptor["dtype"] = string(eltype(value))
            end

            result[name] = descriptor
        catch
            result[name] = Dict{String,Any}("type" => "unknown", "preview" => "<unknown>")
        end
    end

    return result
end
