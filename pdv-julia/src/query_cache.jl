# query_cache.jl — Lock-guarded tree-listing snapshot for busy-time queries.
#
# The query server's threaded mode (query_server.jl) answers `pdv.tree.list`
# while the main thread is compute-bound. It must NEVER touch live tree
# values from another thread — Julia has no GIL, and a Dict mid-rehash on the
# main thread would race (see the tree-query design notes). Instead, queries
# are served from this snapshot: a `parent_path => [child descriptors]` map
# covering every expandable container in the root tree, built ON THE MAIN
# THREAD (where mutations also happen, so the walk itself never races) and
# swapped in atomically under a lock.
#
# Rebuild points — all main-thread, all at natural yield/boundary moments:
#   - pdv.init and project load (initial population),
#   - the tree-changed debounce flush (~100 ms after mutations settle),
#   - IJulia's postexecute hook (catches composite-dict mutations that don't
#     pass through PDVTree setindex!, same drift the 1 Hz poll corrects).
# During a tight compute loop no rebuild runs — the snapshot serves the
# pre-execution state, which is exactly the stale-but-responsive browsing
# contract (mid-run mutations surface at the next yield, issue #8).

const _QUERY_CACHE_LOCK = ReentrantLock()
const _QUERY_CACHE = Ref{Union{Nothing,Dict{String,Vector{Dict{String,Any}}}}}(nothing)

# Descriptor-count cap per rebuild: a runaway tree (millions of nodes) must
# not turn every debounce flush into a multi-second walk. Paths beyond the
# cap are simply absent from the snapshot; queries for them bounce to the
# comm channel and get served live at the next idle moment.
const _QUERY_CACHE_MAX_NODES = 50_000

"""
    rebuild_query_cache!(tree) -> Nothing

Walk the root tree and swap in a fresh listings snapshot. Main-thread only
(callers are mutation-path hooks and execution boundaries). Never throws —
a failed rebuild leaves the previous snapshot in place.
"""
function rebuild_query_cache!(tree)::Nothing
    listings = Dict{String,Vector{Dict{String,Any}}}()
    try
        count = Ref(0)
        _cache_walk!(listings, tree, "", count, IdDict{Any,Nothing}())
    catch err
        @warn "query-cache rebuild failed; keeping previous snapshot" exception = err
        return nothing
    end
    lock(_QUERY_CACHE_LOCK) do
        _QUERY_CACHE[] = listings
    end
    nothing
end

function _cache_walk!(listings::Dict{String,Vector{Dict{String,Any}}},
                      container, path::String, count::Ref{Int},
                      seen::IdDict{Any,Nothing})
    count[] > _QUERY_CACHE_MAX_NODES && return nothing
    # Cycle guard (same identity-based scheme as checksum.jl's _mark_seen!):
    # a self-referential Dict would otherwise recurse to the node cap — or a
    # StackOverflow — on EVERY rebuild, leaving the snapshot permanently
    # stale. A revisited container keeps its first listing; deeper paths
    # into the cycle bounce to the live comm channel like capped paths do.
    # Only mutable containers are tracked: every reference cycle passes
    # through one, and equal immutables (two `(1, 2)` tuples) may be
    # `===`-merged, which would wrongly skip the second listing.
    if ismutable(container)
        haskey(seen, container) && return nothing
        seen[container] = nothing
    end
    if container isa PDVHdf5
        # File-backed HDF5 node: serve from the per-handle memo so a large
        # (immutable, read-only) hierarchy isn't re-walked from disk on
        # every rebuild — rebuilds fire at up to ~1 Hz.
        _merge_hdf5_snapshot!(listings, container, path, count)
        return nothing
    end
    if !(container isa Union{AbstractPDVTree,AbstractDict,NamedTuple,AbstractVector,Tuple})
        # Other virtual containers (e.g. a live HDF5.Group a user stored in
        # the tree): list live, but an unreadable one skips its own subtree
        # instead of aborting the whole rebuild.
        try
            _cache_list_and_recurse!(listings, container, path, count, seen)
        catch err
            @warn "query-cache: skipping unreadable virtual container at '$path'" exception = err
        end
        return nothing
    end
    _cache_list_and_recurse!(listings, container, path, count, seen)
    nothing
end

function _cache_list_and_recurse!(listings::Dict{String,Vector{Dict{String,Any}}},
                                  container, path::String, count::Ref{Int},
                                  seen::IdDict{Any,Nothing})
    nodes, expandable = _list_container_nodes(container, path)
    listings[path] = nodes
    count[] += length(nodes)
    for (child_path, child) in expandable
        _cache_walk!(listings, child, child_path, count, seen)
    end
    nothing
end

# ---------------------------------------------------------------------------
# PDVHdf5 snapshot memo
# ---------------------------------------------------------------------------
#
# The backing file of a PDVHdf5 node is read-only and byte-immutable in UUID
# storage, so its listings can only change when the handle changes (close /
# relocate) or the node moves to a different tree path. The memo stores the
# node's full sub-hierarchy of listings, keyed by the tree-path prefix it
# was built at, and is invalidated by `close_hdf5!`. Without it, a large .h5
# hierarchy would be re-read from disk on every snapshot rebuild.

"""Merge the (memoized) listings under a `PDVHdf5` node into the snapshot.
Never throws — an unreadable file skips this subtree."""
function _merge_hdf5_snapshot!(listings::Dict{String,Vector{Dict{String,Any}}},
                               node::PDVHdf5, path::String, count::Ref{Int})
    snap = try
        _hdf5_snapshot_listings!(node, path)
    catch err
        @warn "query-cache: skipping unreadable HDF5 node at '$path'" exception = err
        return nothing
    end
    for (p, nodes) in snap
        count[] > _QUERY_CACHE_MAX_NODES && break
        listings[p] = nodes
        count[] += length(nodes)
    end
    nothing
end

"""
    _hdf5_snapshot_listings!(node, prefix) -> Dict{String,Vector{Dict}}

Return the complete `tree-path => child descriptors` map for everything
under `node` (main task only; opens the file on first use). Memoized on the
node per open handle and prefix; a rename/move rebuilds at the new prefix.
"""
function _hdf5_snapshot_listings!(node::PDVHdf5, prefix::String)
    memo = node.listing_memo
    if memo !== nothing && node.handle !== nothing && memo[1] == prefix
        return memo[2]
    end
    listings = Dict{String,Vector{Dict{String,Any}}}()
    count = Ref(0)
    _hdf5_snapshot_walk!(listings, node, prefix, count)
    # Memoize only while a handle is open — close_hdf5! invalidates.
    node.handle !== nothing && (node.listing_memo = (prefix, listings))
    return listings
end

# No cycle guard: group objects are freshly minted per listing, so identity
# tracking can't work — the node cap bounds a hard-linked cycle instead
# (deeper paths bounce to the live channel, same as any capped path).
function _hdf5_snapshot_walk!(listings::Dict{String,Vector{Dict{String,Any}}},
                              container, path::String, count::Ref{Int})
    count[] > _QUERY_CACHE_MAX_NODES && return nothing
    nodes, expandable = _list_container_nodes(container, path)
    listings[path] = nodes
    count[] += length(nodes)
    for (child_path, child) in expandable
        _hdf5_snapshot_walk!(listings, child, child_path, count)
    end
    nothing
end

"""Drop the snapshot (kernel shutdown / tests)."""
function clear_query_cache!()::Nothing
    lock(_QUERY_CACHE_LOCK) do
        _QUERY_CACHE[] = nothing
    end
    nothing
end

"""
    cached_tree_listing(path) -> Union{Nothing,Vector}

Thread-safe snapshot lookup for the query server's threaded mode. Returns
`nothing` when no snapshot exists or the path isn't in it (deleted, beyond
the node cap, or never expandable) — callers bounce those to the comm
channel.
"""
function cached_tree_listing(path::AbstractString)
    lock(_QUERY_CACHE_LOCK) do
        cache = _QUERY_CACHE[]
        cache === nothing && return nothing
        return get(cache, String(path), nothing)
    end
end
