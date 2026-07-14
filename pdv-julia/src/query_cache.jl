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
        _cache_walk!(listings, tree, "", count)
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
                      container, path::String, count::Ref{Int})
    count[] > _QUERY_CACHE_MAX_NODES && return nothing
    nodes, expandable = _list_container_nodes(container, path)
    listings[path] = nodes
    count[] += length(nodes)
    for (child_path, child) in expandable
        _cache_walk!(listings, child, child_path, count)
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
