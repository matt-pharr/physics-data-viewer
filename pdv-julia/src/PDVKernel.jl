"""
PDVKernel — Physics Data Viewer kernel support package for Julia.

This package implements the kernel side of the PDV comm protocol for Julia.
It is installed into the user's Julia environment and loaded when a
PDV-managed IJulia kernel starts.

Public API:
- PDVTree: the live project data tree (AbstractDict-like)
- PDVScript, PDVNote, PDVGui, PDVNamelist, PDVLib, PDVHDF5: file-backed nodes
- PDVModule: module metadata node
- PDVError: base exception for all PDVKernel errors
- bootstrap(): kernel entry point
- pdv_handle(): handler dispatch for custom types
"""
module PDVKernel

using Dates
using JSON
using OrderedCollections
using Serialization
using SHA
using UUIDs

const VERSION = "1.0.0"
const __pdv_protocol_version__ = "1.0"

# Include source files in dependency order
include("errors.jl")
include("environment.jl")
include("tree.jl")
include("modules.jl")
include("serialization.jl")
include("comms.jl")
include("namespace.jl")
include("namelist_utils.jl")

# Handler dispatch table
const _DISPATCH = Dict{String,Function}()

function register_handler(msg_type::String, handler::Function)
    _DISPATCH[msg_type] = handler
end

function dispatch(msg::Dict)
    msg_type = get(msg, "type", "")
    msg_id = get(msg, "msg_id", nothing)
    handler = get(_DISPATCH, msg_type, nothing)

    if handler === nothing
        response_type = isempty(msg_type) ? "pdv.unknown.response" : "$msg_type.response"
        send_error(response_type, "protocol.unknown_type",
                   "Unknown PDV message type: '$msg_type'"; in_reply_to=msg_id)
        return
    end

    try
        handler(msg)
    catch e
        response_type = isempty(msg_type) ? "pdv.unknown.response" : "$msg_type.response"
        send_error(response_type, "internal.error", string(e); in_reply_to=msg_id)
    end
end

# Include handlers (they register themselves via register_handler)
include("handlers/lifecycle.jl")
include("handlers/tree.jl")
include("handlers/project.jl")
include("handlers/script.jl")
include("handlers/note.jl")
include("handlers/gui.jl")
include("handlers/modules.jl")
include("handlers/namespace.jl")
include("handlers/namelist.jl")

# Register all handlers
function _register_all_handlers()
    register_handler("pdv.init", handle_init)
    register_handler("pdv.tree.list", handle_tree_list)
    register_handler("pdv.tree.get", handle_tree_get)
    register_handler("pdv.tree.resolve_file", handle_tree_resolve_file)
    register_handler("pdv.project.load", handle_project_load)
    register_handler("pdv.project.save", handle_project_save)
    register_handler("pdv.script.register", handle_script_register)
    register_handler("pdv.note.register", handle_note_register)
    register_handler("pdv.gui.register", handle_gui_register)
    register_handler("pdv.module.register", handle_module_register)
    register_handler("pdv.modules.setup", handle_modules_setup)
    register_handler("pdv.handler.invoke", handle_handler_invoke)
    register_handler("pdv.namespace.query", handle_namespace_query)
    register_handler("pdv.namelist.read", handle_namelist_read)
    register_handler("pdv.namelist.write", handle_namelist_write)
    register_handler("pdv.file.register", handle_file_register)
end

# Register handlers at module load time
_register_all_handlers()

"""
    bootstrap()

Bootstrap the PDVKernel package inside a running IJulia kernel.

This is the entry point called by the Electron app after kernel start.
It registers the `pdv.kernel` comm target, injects `pdv_tree` and `pdv`
as const bindings in Main, and sends the `pdv.ready` comm message.

Must be idempotent.
"""
function bootstrap()
    if _bootstrapped[]
        return
    end

    # Create the tree and app objects
    tree = PDVTree()
    app = PDVApp()
    app.handle = pdv_handle

    # Store reference for handler use
    _pdv_tree[] = tree

    # Inject into Main as const bindings for namespace protection
    try
        Core.eval(Main, :(const pdv_tree = $(tree)))
        Core.eval(Main, :(const pdv = $(app)))
    catch e
        # If const already exists (kernel reconnect), update the reference
        if occursin("cannot assign", string(e))
            @warn "pdv_tree/pdv already exist in Main (kernel reconnect?)"
        else
            rethrow()
        end
    end

    # Attach comm send function to tree for push notifications
    attach_comm!(tree, (msg_type, payload) -> send_message(msg_type, payload))

    # Register the comm target with IJulia
    try
        register_comm_target()
    catch e
        @warn "Failed to register comm target: $e"
    end

    _bootstrapped[] = true
end

# Exports
export PDVTree, PDVFile, PDVScript, PDVNote, PDVGui, PDVNamelist, PDVLib, PDVModule, PDVHDF5
export PDVError, PDVPathError, PDVKeyError, PDVSerializationError, PDVScriptError
export bootstrap, pdv_handle, pdv_preview
export run_script, run_tree_script
export file_preview, relative_path, resolve_file_path

end # module PDVKernel
