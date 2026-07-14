# checksum.jl — Content-based Merkle-tree checksum for PDVTree.
#
# Port of pdv/checksum.py. Computes a canonical, content-based checksum
# directly from the in-memory tree:
#   - independent of serialization order and timestamps,
#   - recursively callable on any sub-tree (Merkle structure),
#   - stable across save/load round-trips.
#
# The Python kernel uses XXH3-128; the Julia kernel uses SHA-256 truncated to
# 128 bits (32 hex chars) to avoid a binary dependency. The checksum is opaque
# to the app — it is only ever compared against other checksums produced by
# the same kernel — so the algorithms do not need to agree across languages.
# The type-tag feeding scheme mirrors the Python implementation, with one
# deliberate divergence: unknown-kind *struct* values are digested by walking
# their fields through the canonical feed rather than hashing Serialization
# bytes. Python's pickled-bytes fallback is round-trip stable because Python
# dicts preserve insertion order; Julia Dicts are hash tables, so a
# deserialized Dict can iterate — and therefore re-serialize — in a different
# order than the original. The structural walk hashes Dicts with sorted keys,
# keeping digests stable across save/load and across processes. The walk
# carries a visited-set of mutable containers so cyclic object graphs (Makie
# figures, self-referential Dicts) terminate — pickle's memo table gave
# Python this for free; a plain recursive walk must do it explicitly.

const _DIGEST_BYTES = 16  # 128-bit truncation

# Cap on _feed_node! invocations per node digest. Plain data (arrays,
# DataFrames, user structs of vectors) feeds in bulk and never comes close,
# and even a live Makie Figure's observable graph walks in ~125k feeds
# (~0.2 s warm) — the budget is a safety net against genuinely unbounded
# object graphs, not a cost ceiling for normal values. Exhaustion (or any
# error the walk trips over in exotic fields) aborts the walk and the digest
# falls back to hashing the node's Serialization bytes: fast, complete, and
# deterministic, at the cost of round-trip digest stability for that node
# (an acceptable trade for values this exotic — the autosave cache just
# re-serializes them once after a project load).
const _WALK_FEED_BUDGET = 1_000_000

# Sentinel thrown by _feed_node! when the feed budget is exhausted.
struct _WalkBudgetExhausted <: Exception end

# Mutable walk state threaded through _feed_node!: the visited-set for cycle
# detection, the remaining feed budget, and a per-walk cache of
# `hasmethod(pdv_digest, ...)` answers — method-table lookups cost tens of
# microseconds and dominated figure-digest profiles when repeated for every
# one of ~10⁵ visited objects. The cache lives only for one digest run, so
# methods defined between digests are still picked up.
mutable struct _WalkState
    seen::IdDict{Any,Nothing}
    budget::Int
    has_pdv_digest::Dict{DataType,Bool}
end
_WalkState() = _WalkState(IdDict{Any,Nothing}(), _WALK_FEED_BUDGET, Dict{DataType,Bool}())

_has_pdv_digest(state::_WalkState, T::DataType) =
    get!(() -> hasmethod(pdv_digest, Tuple{T}), state.has_pdv_digest, T)

# Cheap, bounded type tag for the digest feed. Printing a full parametric
# type (`string(T)`) costs milliseconds — and megabytes — for deeply-nested
# GUI types like Makie plot objects; the module + type name is enough to
# disambiguate (field content feeds separately), and it's nanoseconds.
function _feed_type_tag!(ctx, T::Type)
    try
        _feed_str!(ctx, string(parentmodule(T)))
        _feed_str!(ctx, string(nameof(T)))
    catch
        _feed_str!(ctx, "anontype")
    end
    nothing
end

_feed!(ctx::SHA.SHA2_256_CTX, bytes::AbstractVector{UInt8}) = SHA.update!(ctx, bytes)
_feed!(ctx::SHA.SHA2_256_CTX, s::AbstractString) = SHA.update!(ctx, codeunits(s))

# Length-prefixed UTF-8 string (little-endian UInt64 prefix, like struct '<Q').
function _feed_str!(ctx, s::AbstractString)
    encoded = codeunits(s)
    _feed!(ctx, reinterpret(UInt8, [htol(UInt64(length(encoded)))]))
    _feed!(ctx, encoded)
end

_feed_u64!(ctx, n::Integer) = _feed!(ctx, reinterpret(UInt8, [htol(UInt64(n))]))
_feed_f64!(ctx, x::Float64) = _feed!(ctx, reinterpret(UInt8, [htol(reinterpret(UInt64, x))]))

"""
    tree_checksum(node, working_dir=nothing) -> String

Return a 32-character hex digest for a tree node or any sub-tree. If `node`
is an `AbstractPDVTree` and `working_dir` is `nothing`, the node's own
working directory is used. File-backed nodes are hashed including their file
content; missing files feed a sentinel rather than throwing.
"""
function tree_checksum(node, working_dir::Union{Nothing,AbstractString}=nothing)::String
    if working_dir === nothing && node isa AbstractPDVTree
        working_dir = node.working_dir
    end
    return bytes2hex(node_digest(node, working_dir))
end

"""
    node_digest(node, working_dir) -> Vector{UInt8}

Return the 16-byte digest for a single node. The canonical structural walk
is attempted first; if it exhausts its feed budget or errors on an exotic
value (see `_WALK_FEED_BUDGET`), the digest falls back to the node's
Serialization bytes, and as a last resort to a pointer-stripped `repr`.
"""
function node_digest(node, working_dir::Union{Nothing,AbstractString})::Vector{UInt8}
    # Make sure lazily-registered default pdv_digest methods (e.g. the
    # rendered-pixels digest for Makie figures) exist before the walk decides
    # how to digest — otherwise a checksum computed right after project load
    # (before any handler lookup ran) would disagree with one computed after.
    # O(1) unless a new module was loaded since the last call.
    register_default_handlers!()
    ctx = SHA.SHA2_256_CTX()
    try
        _feed_node!(ctx, node, working_dir, _WalkState())
        return SHA.digest!(ctx)[1:_DIGEST_BYTES]
    catch err
        err isa InterruptException && rethrow()
    end
    # Fallback: hash the Serialization bytes (complete and deterministic for
    # identical in-memory content; a Makie Figure digests this way in ~0.1 s
    # where the structural walk churned for tens of seconds).
    ctx = SHA.SHA2_256_CTX()
    _feed!(ctx, "walk_fallback\0")
    payload = try
        io = IOBuffer()
        Serialization.serialize(io, node)
        take!(io)
    catch
        nothing
    end
    if payload !== nothing
        _feed_u64!(ctx, length(payload))
        _feed!(ctx, payload)
    else
        _feed_str!(ctx, replace(repr(node), r"@0x[0-9a-fA-F]+" => "", r" at 0x[0-9a-fA-F]+" => ""))
    end
    return SHA.digest!(ctx)[1:_DIGEST_BYTES]
end

# Mark a mutable container as visited before recursing into it; on a revisit,
# feed a fixed marker instead of the content and skip the recursion. This is
# what keeps the walk total on cyclic object graphs (a Makie Figure's scene
# graph, a self-referential Dict) — Python never needed it because its unknown
# fallback is pickle, whose memo table handles cycles natively. Only mutable
# objects are tracked: every reference cycle passes through at least one
# mutable object, and immutable values (strings, tuples) may be `===`-merged
# by the compiler, which would make an identity-based marker unstable.
# Visited objects are never un-marked, so shared (diamond) references also
# collapse to the marker — the walk order is deterministic (sorted keys,
# declaration-order fields), and Julia's Serialization preserves identity of
# mutable objects within one file, so digests stay round-trip stable.
function _mark_seen!(ctx, state::_WalkState, node)::Bool
    if haskey(state.seen, node)
        _feed!(ctx, "backref\0")
        return true
    end
    state.seen[node] = nothing
    return false
end

# Stream file content into the hasher in 64 KiB chunks; sentinel on missing.
function _feed_file_content!(ctx, node::AbstractPDVFile,
                             working_dir::Union{Nothing,AbstractString})
    if working_dir === nothing
        _feed!(ctx, "<missing_file>")
        return
    end
    abs_path = resolve_path(node, working_dir)
    if !isfile(abs_path)
        _feed!(ctx, "<missing_file>")
        return
    end
    try
        open(abs_path, "r") do io
            buf = Vector{UInt8}(undef, 65536)
            while !eof(io)
                n = readbytes!(io, buf)
                _feed!(ctx, view(buf, 1:n))
            end
        end
    catch
        _feed!(ctx, "<missing_file>")
    end
    nothing
end

function _feed_node!(ctx, node, working_dir::Union{Nothing,AbstractString},
                     state::_WalkState)
    (state.budget -= 1) < 0 && throw(_WalkBudgetExhausted())
    kind = detect_kind(node)

    if kind == KIND_FOLDER
        _feed!(ctx, "folder\0")
        sorted_keys = sort!(collect(keys(node.data)))
        _feed_u64!(ctx, length(sorted_keys))
        for key in sorted_keys
            _feed_str!(ctx, key)
            _feed!(ctx, node_digest(node.data[key], working_dir))
        end

    elseif kind == KIND_MODULE
        _feed!(ctx, "module\0")
        _feed_str!(ctx, node.module_id)
        _feed_str!(ctx, node.name)
        _feed_str!(ctx, node.version)
        sorted_keys = sort!(collect(keys(node.data)))
        _feed_u64!(ctx, length(sorted_keys))
        for key in sorted_keys
            _feed_str!(ctx, key)
            _feed!(ctx, node_digest(node.data[key], working_dir))
        end

    elseif kind == KIND_SCALAR
        # Guarded: exotic Number subtypes can fail to print (e.g.
        # GeometryBasics.OffsetInteger, whose broken `zero` makes `string`
        # throw InexactError) — feed the type name instead of erroring the
        # whole walk. Partial feeds before a throw are deterministic per value.
        try
            if node === nothing || node === missing
                _feed!(ctx, "scalar\0null\0")
            elseif node isa Bool
                _feed!(ctx, "scalar\0bool\0")
                _feed!(ctx, UInt8[node ? 0x01 : 0x00])
            elseif node isa Integer
                _feed!(ctx, "scalar\0int\0")
                _feed_str!(ctx, string(node))
            elseif node isa Complex
                _feed!(ctx, "scalar\0complex\0")
                _feed_f64!(ctx, Float64(real(node)))
                _feed_f64!(ctx, Float64(imag(node)))
            elseif node isa AbstractFloat
                _feed!(ctx, "scalar\0float\0")
                _feed_f64!(ctx, Float64(node))
            else
                # Rational, Irrational, and friends: stable string form.
                _feed!(ctx, "scalar\0other\0")
                _feed_str!(ctx, string(node))
            end
        catch
            _feed!(ctx, "scalar\0unprintable\0")
            _feed_type_tag!(ctx, typeof(node))
        end

    elseif kind == KIND_TEXT
        _feed!(ctx, "text\0")
        _feed_str!(ctx, String(node))

    elseif kind == KIND_BINARY
        _feed!(ctx, "binary\0")
        _feed_u64!(ctx, length(node))
        _feed!(ctx, node)

    elseif kind == KIND_MAPPING
        _mark_seen!(ctx, state, node) && return
        _feed!(ctx, "mapping\0")
        sorted_keys = sort!(collect(keys(node)); by=string)
        _feed_u64!(ctx, length(sorted_keys))
        for key in sorted_keys
            _feed_str!(ctx, string(key))
            _feed_node!(ctx, node[key], working_dir, state)
        end

    elseif kind == KIND_SEQUENCE
        ismutable(node) && _mark_seen!(ctx, state, node) && return
        # Type-tag the concrete sequence flavor so tuple ↔ vector swaps
        # produce a different digest. Sets are sorted by repr for determinism.
        local items
        if node isa Tuple
            _feed!(ctx, "sequence\0tuple\0")
            items = node
        elseif node isa AbstractSet
            _feed!(ctx, "sequence\0set\0")
            items = sort!(collect(node); by=repr)
        else
            _feed!(ctx, "sequence\0list\0")
            items = node
        end
        _feed_u64!(ctx, length(node))
        for item in items
            _feed_node!(ctx, item, working_dir, state)
        end

    elseif kind == KIND_NDARRAY
        _feed!(ctx, "ndarray\0")
        _feed_str!(ctx, _dtype_name(eltype(node)))
        _feed_u64!(ctx, ndims(node))
        for d in size(node)
            _feed_u64!(ctx, d)
        end
        if node isa Array{Bool}
            _feed!(ctx, UInt8[b ? 0x01 : 0x00 for b in vec(node)])
        else
            _feed!(ctx, reinterpret(UInt8, vec(node)))
        end

    elseif kind == KIND_DATAFRAME
        _feed!(ctx, "dataframe\0")
        # invokelatest throughout: DataFrames may have been loaded after the
        # caller's frame world was fixed (e.g. auto-required mid project-load).
        mod = loaded_module(:DataFrames)
        cols = Base.invokelatest(getproperty(mod, :names), node)
        _feed_u64!(ctx, length(cols))
        for col in cols
            _feed_str!(ctx, string(col))
            col_vals = Base.invokelatest(getindex, node, !, col)
            _feed_str!(ctx, string(eltype(col_vals)))
            if eltype(col_vals) <: NPY_ELTYPES && col_vals isa Array
                _feed!(ctx, reinterpret(UInt8, col_vals))
            else
                _feed_str!(ctx, repr(collect(col_vals)))
            end
        end

    elseif kind == KIND_SCRIPT
        _feed!(ctx, "script\0")
        _feed_str!(ctx, node.language)
        _feed_file_content!(ctx, node, working_dir)

    elseif kind == KIND_MARKDOWN
        _feed!(ctx, "note\0")
        _feed_file_content!(ctx, node, working_dir)

    elseif kind == KIND_GUI
        _feed!(ctx, "gui\0")
        _feed_file_content!(ctx, node, working_dir)

    elseif kind == KIND_NAMELIST
        _feed!(ctx, "namelist\0")
        _feed_str!(ctx, node.format)
        _feed_file_content!(ctx, node, working_dir)

    elseif kind == KIND_LIB
        _feed!(ctx, "lib\0")
        _feed_file_content!(ctx, node, working_dir)

    else  # KIND_UNKNOWN (and KIND_FILE base kind)
        _feed!(ctx, "unknown\0")
        if node isa AbstractPDVFile
            _feed_file_content!(ctx, node, working_dir)
            return
        end
        # Protocol digest wins when the type provides one.
        if typeof(node) isa DataType && _has_pdv_digest(state, typeof(node))
            payload = try
                p = Base.invokelatest(pdv_digest, node)
                p isa AbstractVector{UInt8} ? Vector{UInt8}(p) : Vector{UInt8}(codeunits(string(p)))
            catch
                nothing
            end
            if payload !== nothing
                _feed!(ctx, "dunder\0")
                _feed_u64!(ctx, length(payload))
                _feed!(ctx, payload)
                return
            end
        end
        T = typeof(node)
        # Raw pointers: the address is process-specific garbage (e.g. a Cairo
        # surface handle inside a Makie figure) — feed only the type so the
        # digest is stable across sessions and save/load round trips.
        if node isa Ptr
            _feed!(ctx, "ptr\0")
            _feed_str!(ctx, string(T))
            return
        end
        # Functions and closures: feed by name, not content. Serializing a
        # function value writes its entire lowered code (milliseconds each,
        # and observable graphs hold thousands of listener closures); pickle
        # does the same name-only thing for Python functions.
        if node isa Function
            _feed!(ctx, "function\0")
            _feed_type_tag!(ctx, typeof(node))
            return
        end
        # Arrays of non-numeric eltype: canonical per-element feed.
        if node isa AbstractArray
            ismutable(node) && _mark_seen!(ctx, state, node) && return
            _feed!(ctx, "array\0")
            _feed_type_tag!(ctx, T)
            _feed_u64!(ctx, ndims(node))
            for d in size(node)
                _feed_u64!(ctx, d)
            end
            for el in node
                _feed_node!(ctx, el, working_dir, state)
            end
            return
        end
        # Plain structs: walk fields through the canonical feed. This — not
        # Serialization bytes — is what keeps digests stable across
        # save/load: `serialize(deserialize(x))` differs from `serialize(x)`
        # whenever the value contains a Dict, because rebuilt hash tables can
        # iterate in a different order. The recursive feed hashes Dicts with
        # sorted keys, so layout never leaks into the digest.
        if isstructtype(T) && !(node isa Function)
            ismutabletype(T) && _mark_seen!(ctx, state, node) && return
            _feed!(ctx, "struct\0")
            _feed_type_tag!(ctx, T)
            fns = fieldnames(T)
            _feed_u64!(ctx, length(fns))
            for f in fns
                _feed_str!(ctx, string(f))
                if isdefined(node, f)
                    _feed_node!(ctx, getfield(node, f), working_dir, state)
                else
                    _feed!(ctx, "undef\0")
                end
            end
            return
        end
        # Serialization bytes as a content-based fallback for the rest
        # (functions, exotic non-struct values).
        payload = try
            io = IOBuffer()
            Serialization.serialize(io, node)
            take!(io)
        catch
            nothing
        end
        if payload !== nothing
            _feed!(ctx, "pickle\0")
            _feed_u64!(ctx, length(payload))
            _feed!(ctx, payload)
            return
        end
        # Last resort: repr with any pointer addresses stripped.
        _feed_str!(ctx, replace(repr(node), r"@0x[0-9a-fA-F]+" => "", r" at 0x[0-9a-fA-F]+" => ""))
    end
    nothing
end
