"""
pdv_kernel.errors — PDV exception hierarchy.

All exceptions raised by pdv_kernel are subclasses of PDVError.
This allows callers to catch all PDV-specific errors with a single
``except PDVError`` clause.
"""


class PDVError(Exception):
    """Base exception for all pdv_kernel errors."""


class PDVPathError(PDVError):
    """Raised when a path is invalid, escapes the project root, or is otherwise unsafe."""


class PDVKeyError(PDVError, KeyError):
    """Raised when a tree path does not exist."""


class PDVProtectedNameError(PDVError):
    """Raised when user code attempts to reassign a protected kernel namespace name."""


class PDVSerializationError(PDVError):
    """Raised when a value cannot be serialized to or deserialized from disk."""


class PDVScriptError(PDVError):
    """Raised when a script fails to load or its run() function raises."""


class PDVCommError(PDVError):
    """Raised when a PDV comm message response has status='error'."""


class PDVVersionError(PDVError):
    """Raised when the app's expected protocol version is incompatible with this package."""


class PDVSchemaError(PDVError):
    """Raised when a project manifest or tree-index has an unsupported schema version."""
