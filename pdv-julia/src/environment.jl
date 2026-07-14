# environment.jl — Path utilities and working directory management.
#
# Centralises all filesystem path logic for PDVKernel (port of pdv/environment.py):
# working-dir validation, the kernel-CWD policy, UUID-based node storage paths,
# and the atomic `smart_copy` helper.
#
# This file has NO dependency on IJulia or comms — it is importable and testable
# standalone.

const NODE_UUID_RE = r"^[0-9a-f]{12}$"

"""
    reset_cwd_to_home()

Point the kernel process's CWD at the user's home directory.

PDV deliberately keeps the process CWD out of both the ephemeral working
directory and the project save directory so that relative paths in user code
resolve somewhere durable. Called after `pdv.init` and after every project
load. Failures are swallowed — an unreadable home directory must not break
kernel init.
"""
function reset_cwd_to_home()
    try
        cd(homedir())
    catch
        @warn "Could not chdir to home directory; CWD left unchanged."
    end
    nothing
end

"""
    validate_working_dir(path) -> String

Validate that a working directory path exists, is a directory, and is
writable. Returns the realpath-resolved absolute path.

Throws `PDVPathError` otherwise.
"""
function validate_working_dir(path::AbstractString)::String
    resolved = ispath(path) ? realpath(path) : String(path)
    if !ispath(resolved)
        throw(PDVPathError("Working directory does not exist: $path"))
    end
    if !isdir(resolved)
        throw(PDVPathError("Working directory path is not a directory: $path"))
    end
    if !iswritable_dir(resolved)
        throw(PDVPathError("Working directory is not writable: $path"))
    end
    return resolved
end

# Probe writability by uid/gid-independent means: try touching a temp name.
function iswritable_dir(dir::AbstractString)::Bool
    probe = joinpath(dir, ".pdv-write-probe-$(getpid())")
    try
        touch(probe)
        rm(probe; force=true)
        return true
    catch
        return false
    end
end

"""
    ensure_parent(path) -> path

Create parent directories of `path` if they do not exist. Returns `path`
unchanged for chaining.
"""
function ensure_parent(path::AbstractString)
    mkpath(dirname(path))
    return path
end

# ---------------------------------------------------------------------------
# UUID-based file storage helpers (ARCHITECTURE.md §6.3)
# ---------------------------------------------------------------------------

"""
    generate_node_uuid() -> String

Generate a 12-hex-character UUID for a tree node (from UUID4).
"""
generate_node_uuid()::String = first(replace(string(UUIDs.uuid4()), "-" => ""), 12)

"""
    uuid_tree_path(working_dir, node_uuid, filename) -> String

Compute `<working_dir>/tree/<node_uuid>/<filename>`, rejecting path-traversal
characters in `node_uuid` and `filename`.
"""
function uuid_tree_path(working_dir::AbstractString, node_uuid::AbstractString,
                        filename::AbstractString)::String
    if occursin("..", node_uuid) || occursin("/", node_uuid) || occursin("\\", node_uuid)
        throw(ArgumentError("Unsafe node UUID: $(repr(node_uuid))"))
    end
    if occursin("..", filename) || occursin("/", filename) || occursin("\\", filename)
        throw(ArgumentError("Unsafe filename: $(repr(filename))"))
    end
    return joinpath(working_dir, "tree", node_uuid, filename)
end

# Streaming SHA-256 of a file's contents (used by smart_copy's identical-skip).
function _file_digest(path::AbstractString)::Vector{UInt8}
    ctx = SHA.SHA2_256_CTX()
    open(path, "r") do io
        buf = Vector{UInt8}(undef, 1 << 16)
        while !eof(io)
            n = readbytes!(io, buf)
            SHA.update!(ctx, view(buf, 1:n))
        end
    end
    return SHA.digest!(ctx)
end

"""
    smart_copy(src, dst)

Copy a file atomically: stage at a sibling `<dst>.tmp`, then rename onto
`dst`. A crash mid-copy leaves `dst` either fully-old or fully-new, never
torn — the invariant file-backed PDV nodes rely on for crash-safe in-place
overwrites.

If `dst` already exists and is byte-identical to `src` (same size + SHA-256),
the copy is skipped with no I/O. Stale `<dst>.tmp` files from a prior crash
are swept first.
"""
function smart_copy(src::AbstractString, dst::AbstractString)
    tmp = dst * ".tmp"
    # Sweep stale temp from a previous crashed save before the fast-path check.
    rm(tmp; force=true)

    # Fast-path: identical destination — skip the rest of the I/O.
    if isfile(dst) && filesize(src) == filesize(dst) && _file_digest(src) == _file_digest(dst)
        return nothing
    end

    ensure_parent(dst)
    try
        cp(src, tmp; force=true)
        mv(tmp, dst; force=true)
    catch
        rm(tmp; force=true)
        rethrow()
    end
    nothing
end
