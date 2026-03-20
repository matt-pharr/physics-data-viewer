# PDVKernel environment — Path utilities and working directory management.
#
# Centralises all filesystem path logic for PDVKernel:
# - Creating and validating the working directory
# - Resolving project-relative paths with traversal protection
# - Utility helpers used by serialization.jl and tree.jl
#
# This module has NO dependency on IJulia, comms, or any Electron-facing code.

"""
    make_working_dir(base_tmp_dir::String) -> String

Create a uniquely named PDV working directory under `base_tmp_dir`.
"""
function make_working_dir(base_tmp_dir::String)::String
    if !isdir(base_tmp_dir)
        throw(PDVPathError("Base temporary directory does not exist: $base_tmp_dir"))
    end
    return mktempdir(base_tmp_dir; prefix="pdv-")
end

"""
    validate_working_dir(path::String) -> String

Validate that a working directory path is usable.
Returns the realpath-resolved absolute path.
"""
function validate_working_dir(path::String)::String
    if !ispath(path)
        throw(PDVPathError("Working directory does not exist: $path"))
    end
    resolved = realpath(path)
    if !ispath(resolved)
        throw(PDVPathError("Working directory does not exist: $path"))
    end
    if !isdir(resolved)
        throw(PDVPathError("Working directory path is not a directory: $path"))
    end
    # Check writable by attempting to stat
    try
        tmpf = tempname(resolved)
        open(tmpf, "w") do f
            write(f, "")
        end
        rm(tmpf)
    catch
        throw(PDVPathError("Working directory is not writable: $path"))
    end
    return resolved
end

"""
    resolve_project_path(relative_path::String, project_root::String) -> String

Resolve a project-relative path to an absolute path, rejecting traversal.
"""
function resolve_project_path(relative_path::String, project_root::String)::String
    if isabspath(relative_path)
        throw(PDVPathError("Expected a relative path, got absolute path: $relative_path"))
    end
    candidate = realpath(joinpath(project_root, relative_path))
    root = realpath(project_root)
    if !path_is_safe(candidate, root)
        throw(PDVPathError("Path '$relative_path' escapes the project root '$project_root'"))
    end
    return candidate
end

"""
    path_is_safe(candidate::String, root::String) -> Bool

Return true if `candidate` is inside `root` (no traversal).
"""
function path_is_safe(candidate::String, root::String)::Bool
    try
        c = realpath(candidate)
        r = realpath(root)
        return c == r || startswith(c, r * Base.Filesystem.path_separator)
    catch
        return false
    end
end

"""
    working_dir_tree_path(working_dir::String, tree_path::String, extension::String) -> String

Compute the absolute filesystem path for a tree node's data file.
Maps a dot-separated tree path to a filesystem path under the working
directory's `tree/` subdirectory.
"""
function working_dir_tree_path(working_dir::String, tree_path::String, extension::String)::String
    parts = split(tree_path, ".")
    return joinpath(working_dir, "tree", parts[1:end-1]..., string(parts[end], extension))
end

"""
    ensure_parent(path::String) -> String

Create parent directories of `path` if they do not exist.
Returns the input path for chaining convenience.
"""
function ensure_parent(path::String)::String
    d = dirname(path)
    if !isempty(d)
        mkpath(d)
    end
    return path
end
