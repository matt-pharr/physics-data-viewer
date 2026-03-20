# PDVKernel error hierarchy.
# All exceptions raised by PDVKernel are subtypes of PDVError.

"""
    PDVError <: Exception

Base exception for all PDVKernel errors.
"""
abstract type PDVError <: Exception end

"""
    PDVPathError(msg::String)

Raised when a path is invalid, escapes the project root, or is otherwise unsafe.
"""
struct PDVPathError <: PDVError
    msg::String
end
Base.showerror(io::IO, e::PDVPathError) = print(io, "PDVPathError: ", e.msg)

"""
    PDVKeyError(msg::String)

Raised when a tree path does not exist and has no lazy-load entry.
"""
struct PDVKeyError <: PDVError
    msg::String
end
Base.showerror(io::IO, e::PDVKeyError) = print(io, "PDVKeyError: ", e.msg)

"""
    PDVProtectedNameError(msg::String)

Raised when user code attempts to reassign a protected kernel namespace name.
"""
struct PDVProtectedNameError <: PDVError
    msg::String
end
Base.showerror(io::IO, e::PDVProtectedNameError) = print(io, "PDVProtectedNameError: ", e.msg)

"""
    PDVSerializationError(msg::String)

Raised when a value cannot be serialized to or deserialized from disk.
"""
struct PDVSerializationError <: PDVError
    msg::String
end
Base.showerror(io::IO, e::PDVSerializationError) = print(io, "PDVSerializationError: ", e.msg)

"""
    PDVScriptError(msg::String)

Raised when a script fails to load or its run() function raises.
"""
struct PDVScriptError <: PDVError
    msg::String
end
Base.showerror(io::IO, e::PDVScriptError) = print(io, "PDVScriptError: ", e.msg)

"""
    PDVCommError(msg::String)

Raised when a PDV comm message response has status='error'.
"""
struct PDVCommError <: PDVError
    msg::String
end
Base.showerror(io::IO, e::PDVCommError) = print(io, "PDVCommError: ", e.msg)

"""
    PDVVersionError(msg::String)

Raised when the app's expected protocol version is incompatible with this package.
"""
struct PDVVersionError <: PDVError
    msg::String
end
Base.showerror(io::IO, e::PDVVersionError) = print(io, "PDVVersionError: ", e.msg)

"""
    PDVSchemaError(msg::String)

Raised when a project manifest or tree-index has an unsupported schema version.
"""
struct PDVSchemaError <: PDVError
    msg::String
end
Base.showerror(io::IO, e::PDVSchemaError) = print(io, "PDVSchemaError: ", e.msg)
