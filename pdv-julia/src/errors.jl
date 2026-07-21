# errors.jl — PDV exception hierarchy.
#
# All exceptions raised by PDVKernel are subtypes of PDVException, so callers
# can catch every PDV-specific error with a single `catch e; e isa PDVException`.
# Mirrors pdv-python's pdv/errors.py.

"""
    PDVException

Abstract supertype for all PDVKernel errors (mirror of Python's `PDVError`).
"""
abstract type PDVException <: Exception end

"""Raised when a path is invalid, escapes the project root, or is otherwise unsafe."""
struct PDVPathError <: PDVException
    msg::String
end

"""Raised when a tree path does not exist."""
struct PDVKeyError <: PDVException
    msg::String
end

"""Raised when user code attempts to reassign a protected kernel namespace name."""
struct PDVProtectedNameError <: PDVException
    msg::String
end

"""Raised when a value cannot be serialized to or deserialized from disk."""
struct PDVSerializationError <: PDVException
    msg::String
end

"""Raised when a script fails to load or its `run()` function throws."""
struct PDVScriptError <: PDVException
    msg::String
end

"""Raised when the app's expected protocol version is incompatible with this package."""
struct PDVVersionError <: PDVException
    msg::String
end

Base.showerror(io::IO, e::PDVException) = print(io, nameof(typeof(e)), ": ", e.msg)

# Uniform message accessor (every concrete PDV exception carries `msg`).
error_message(e::PDVException) = e.msg
