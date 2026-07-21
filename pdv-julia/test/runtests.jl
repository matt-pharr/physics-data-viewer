# runtests.jl — PDVKernel test suite.
#
# Mirrors the pdv-python test suite (tests/test_tree.py, test_serialization.py,
# test_handlers_*.py, ...) at the level the Julia port supports. No running
# kernel is required: the comm transport is stubbed via PDVKernel._send_override.

using Test
using PDVKernel
using PDVKernel: set_quiet!, detect_kind, node_preview, serialize_node,
                 deserialize_node, jls_fallback_node, tree_checksum, node_digest,
                 load_tree_index, extract_script_params, _flush_changes,
                 attach_comm!, detach_comm!, generate_node_uuid, uuid_tree_path,
                 smart_copy, validate_working_dir, ensure_parent,
                 dispatch_message, _send_override, _pdv_tree, resolve_path,
                 script_run, run_script, dispatch_handler, has_handler_for,
                 register_handler, clear_handlers!, clear_serializers!,
                 read_namelist, write_namelist, extract_hints, infer_types,
                 detect_namelist_format, QueryServer, start!, stop!,
                 serialize_tree_to_dir, clear_autosave_cache!, _autosave_cache,
                 pdv_namespace, inspect_namespace, namespace_bindings, load_lib_file!,
                 clear_lib_modules!, AutosaveCache, KIND_NDARRAY, KIND_SEQUENCE,
                 KIND_SCALAR, KIND_TEXT, KIND_MAPPING, KIND_BINARY, KIND_UNKNOWN
import JSON
import ZMQ
import Serialization
import Pkg
import TOML
using UUIDs: uuid4
using DataFrames
import HDF5

# ---------------------------------------------------------------------------
# Test harness helpers
# ---------------------------------------------------------------------------

# Capture every envelope send_message produces during f().
function capture_messages(f::Function)
    captured = Dict{String,Any}[]
    old = _send_override[]
    _send_override[] = env -> push!(captured, env)
    try
        f()
    finally
        _send_override[] = old
    end
    return captured
end

# Install a fresh tree as the active PDV tree for handler tests.
function with_active_tree(f::Function, tree::PDVTree)
    old = _pdv_tree[]
    _pdv_tree[] = tree
    try
        f()
    finally
        _pdv_tree[] = old
    end
end

# Build a request envelope the way the app does.
request(msg_type::String, payload::Dict=Dict{String,Any}(); msg_id="test-msg-1") =
    Dict{String,Any}("pdv_version" => PDVKernel.VERSION, "msg_id" => msg_id,
                     "in_reply_to" => nothing, "type" => msg_type,
                     "status" => "ok", "payload" => payload)

# Dispatch a request against a given tree and return the captured envelopes.
function run_handler(tree::PDVTree, msg_type::String, payload::Dict=Dict{String,Any}())
    local captured
    with_active_tree(tree) do
        captured = capture_messages() do
            dispatch_message(request(msg_type, payload))
        end
    end
    return captured
end

response_of(captured, msg_type) =
    only(filter(m -> m["type"] == msg_type * ".response", captured))

# The plot path auto-loads an *installed* CairoMakie on first use; keep that
# off in tests so notice-path assertions are deterministic (and no test ever
# pays a real CairoMakie load) even when the machine's environment stack can
# resolve CairoMakie.
PDVKernel._MAKIE_AUTOLOAD_ENABLED[] = false

# A value Serialization refuses outright, for exercising the save walker's
# skip-and-report path. (A sleeping Task, surprisingly, serializes fine.)
struct _Unserializable end

# Virtual container whose child lookup throws — for pinning haskey's
# exception contract (interrupts propagate, other errors mean "absent").
struct _ThrowingVirtual end
struct _ThrowingAdapter <: PDVKernel.VirtualAdapter end
PDVKernel.virtual_adapter(::_ThrowingVirtual) = _ThrowingAdapter()
PDVKernel.adapter_children(::_ThrowingAdapter, x) = PDVKernel.ChildEntry[]
PDVKernel.adapter_has_children(::_ThrowingAdapter, x) = true
PDVKernel.adapter_child(::_ThrowingAdapter, x, key::String) =
    key == "interrupt" ? throw(InterruptException()) : error("unreadable")
Serialization.serialize(::Serialization.AbstractSerializer, ::_Unserializable) =
    error("refusing to serialize _Unserializable")

# ---------------------------------------------------------------------------

@testset "PDVKernel" begin

@testset "environment" begin
    @test occursin(r"^[0-9a-f]{12}$", generate_node_uuid())
    @test generate_node_uuid() != generate_node_uuid()

    dir = mktempdir()
    @test uuid_tree_path(dir, "a1b2c3d4e5f6", "x.npy") ==
          joinpath(dir, "tree", "a1b2c3d4e5f6", "x.npy")
    @test_throws ArgumentError uuid_tree_path(dir, "../evil", "x.npy")
    @test_throws ArgumentError uuid_tree_path(dir, "a1b2c3d4e5f6", "../x.npy")

    @test validate_working_dir(dir) == realpath(dir)
    @test_throws PDVPathError validate_working_dir(joinpath(dir, "nope"))

    src = joinpath(dir, "src.txt")
    write(src, "hello")
    dst = joinpath(dir, "sub", "dst.txt")
    smart_copy(src, dst)
    @test read(dst, String) == "hello"
    # Identical-content fast path (no error, content unchanged).
    smart_copy(src, dst)
    @test read(dst, String) == "hello"
    write(src, "changed")
    smart_copy(src, dst)
    @test read(dst, String) == "changed"
end

@testset "tree: dot-path access" begin
    t = PDVTree()
    t["a"] = 1
    @test t["a"] == 1
    t["x.y.z"] = "deep"
    @test t["x.y.z"] == "deep"
    @test t["x"] isa PDVTree
    @test t["x.y"] isa PDVTree
    @test haskey(t, "x.y.z")
    @test !haskey(t, "x.y.w")
    @test !haskey(t, "nope")
    @test_throws PDVKeyError t["nope"]
    @test_throws PDVKeyError t["x.nope"]
    @test_throws PDVPathError t["a..b"]
    @test get(t, "x.y.z", nothing) == "deep"
    @test get(t, "x.y.nope", :default) == :default

    # numeric segments through sequences (1-based, negative from end)
    t["records"] = Any[Dict("name" => "first"), Dict("name" => "second")]
    @test t["records.1.name"] == "first"
    @test t["records.2.name"] == "second"
    @test t["records.-1.name"] == "second"
    @test_throws PDVKeyError t["records.3.name"]
    @test_throws PDVKeyError t["records.0.name"]

    # deletion
    delete!(t, "x.y.z")
    @test !haskey(t, "x.y.z")
    @test haskey(t, "x.y")
    @test_throws PDVKeyError delete!(t, "x.y.z")

    # pop
    t["p.q"] = 5
    @test pop!(t, "p.q") == 5
    @test pop!(t, "p.q", :fallback) == :fallback

    # replace non-dict intermediate
    t["leaf"] = 10
    t["leaf.child"] = 20
    @test t["leaf.child"] == 20
    @test t["leaf"] isa PDVTree

    # constructor from dict expands dotted keys
    t2 = PDVTree(Dict("a.b" => 1))
    @test t2["a.b"] == 1
    @test t2["a"] isa PDVTree
end

@testset "tree: change notifications" begin
    t = PDVTree()
    msgs = Tuple{String,Dict}[]
    attach_comm!(t, (ty, pl) -> push!(msgs, (ty, pl)))
    try
        t["k"] = 1
        _flush_changes(t)
        @test length(msgs) == 1
        @test msgs[1][1] == "pdv.tree.changed"
        @test msgs[1][2]["change_type"] == "batch"
        @test msgs[1][2]["changed_paths"] == ["k"]

        empty!(msgs)
        t["k"] = 2   # update
        delete!(t, "k")
        _flush_changes(t)
        @test length(msgs) == 1  # debounced batch
        @test msgs[1][2]["changed_paths"] == ["k"]

        # new intermediate containers are reported ancestors-first
        empty!(msgs)
        t["a.b.c"] = 1
        _flush_changes(t)
        @test msgs[1][2]["changed_paths"] == ["a", "a.b", "a.b.c"]

        # set_quiet! emits nothing
        empty!(msgs)
        set_quiet!(t, "quiet.path", 1)
        _flush_changes(t)
        @test isempty(msgs)
    finally
        detach_comm!(t)
    end
end

@testset "tree: copy and deepcopy detach" begin
    t = PDVTree()
    t["a"] = [1, 2, 3]
    attach_comm!(t, (ty, pl) -> nothing)
    try
        c = copy(t)
        @test c isa PDVTree
        @test c["a"] === t["a"]  # shallow
        @test c.send_fn === nothing

        d = deepcopy(t)
        @test d isa PDVTree
        @test d["a"] == t["a"] && d["a"] !== t["a"]
        @test d.send_fn === nothing

        m = PDVModule(module_id="m", name="M", version="1.0")
        m["x"] = 1
        dm = deepcopy(m)
        @test dm isa PDVModule
        @test dm.module_id == "m"
        @test dm["x"] == 1
    finally
        detach_comm!(t)
    end
end

@testset "detect_kind" begin
    @test detect_kind(PDVTree()) == "folder"
    @test detect_kind(PDVModule(module_id="m", name="M", version="1")) == "module"
    @test detect_kind(PDVScript(uuid="ab", filename="s.jl")) == "script"
    @test detect_kind(PDVNote(uuid="ab", filename="n.md")) == "markdown"
    @test detect_kind(PDVGui(uuid="ab", filename="g.gui.json")) == "gui"
    @test detect_kind(PDVNamelist(uuid="ab", filename="s.nml")) == "namelist"
    @test detect_kind(PDVLib(uuid="ab", filename="l.jl")) == "lib"
    @test detect_kind(PDVFile(uuid="ab", filename="f.h5")) == "file"
    @test detect_kind(1) == "scalar"
    @test detect_kind(1.5) == "scalar"
    @test detect_kind(true) == "scalar"
    @test detect_kind(nothing) == "scalar"
    @test detect_kind(missing) == "scalar"
    @test detect_kind(1 + 2im) == "scalar"
    @test detect_kind("s") == "text"
    @test detect_kind(UInt8[1, 2]) == "binary"
    @test detect_kind(Dict("a" => 1)) == "mapping"
    @test detect_kind((a = 1, b = 2)) == "mapping"   # NamedTuple: dict-like display
    @test detect_kind([1.0, 2.0]) == "ndarray"
    @test detect_kind(rand(3, 3)) == "ndarray"
    @test detect_kind(Any[1, "x"]) == "sequence"
    @test detect_kind((1, 2)) == "sequence"
    @test detect_kind(Set([1])) == "sequence"
    @test detect_kind(1:10) == "sequence"     # ranges list like generic sequences
    @test detect_kind(DataFrame(a=[1, 2])) == "dataframe"
    struct _Blob end
    @test detect_kind(_Blob()) == "unknown"
end

@testset "serialization: round trips" begin
    dir = mktempdir()

    # ndarray → .npy
    arr = rand(5, 4)
    d = serialize_node("data.arr", arr, dir; trusted=true)
    @test d["storage"]["format"] == "npy"
    @test d["metadata"]["dtype"] == "float64"
    @test d["metadata"]["shape"] == [5, 4]
    @test deserialize_node(d["storage"], dir; trusted=true) == arr

    # int vector → .npy
    ivec = Int64[1, 2, 3]
    d = serialize_node("iv", ivec, dir; trusted=true)
    @test d["storage"]["format"] == "npy"
    @test deserialize_node(d["storage"], dir; trusted=true) == ivec

    # scalars inline
    for (val, path) in [(42, "s1"), (2.5, "s2"), (true, "s3"), (nothing, "s4")]
        d = serialize_node(path, val, dir)
        @test d["storage"]["backend"] == "inline"
        @test d["storage"]["value"] === val
    end

    # non-finite floats and complex go to .jls
    for (val, path) in [(NaN, "n1"), (Inf, "n2"), (1 + 2im, "n3")]
        d = serialize_node(path, val, dir; trusted=true)
        @test d["storage"]["format"] == "jls"
        v = deserialize_node(d["storage"], dir; trusted=true)
        val === NaN ? (@test v isa Float64 && isnan(v)) : (@test v === val)
    end

    # short text inline, long text as .txt
    d = serialize_node("t1", "short", dir)
    @test d["storage"]["backend"] == "inline"
    long = repeat("x", 2000)
    d = serialize_node("t2", long, dir; trusted=true)
    @test d["storage"]["format"] == "txt"
    @test deserialize_node(d["storage"], dir; trusted=true) == long

    # JSON-faithful mapping inline
    d = serialize_node("m1", Dict("a" => 1, "b" => "x"), dir)
    @test d["storage"]["backend"] == "inline"

    # mapping with non-JSON values → whole-dict jls with type fidelity
    md = Dict("t" => (1, 2), "s" => Set([1]))
    d = serialize_node("m2", md, dir; trusted=true)
    @test d["storage"]["format"] == "jls"
    v = deserialize_node(d["storage"], dir; trusted=true)
    @test v["t"] === (1, 2) && v["s"] == Set([1])

    # mapping with array leaves → composite container
    d = serialize_node("m3", Dict("arr" => rand(3)), dir; trusted=true)
    @test d["storage"]["backend"] == "none"
    @test d["metadata"]["composite"] == true
    @test d["has_children"] == true

    # NamedTuple: displays as a mapping but persists as ONE .jls leaf —
    # never the composite split, which would reload as a Dict. The concrete
    # NamedTuple type (arrays and all) must survive the round trip.
    nt = (alpha = 1.5, fields = (b = [1.0, 2.0], label = "eq"))
    d = serialize_node("nt", nt, dir; trusted=true)
    @test d["type"] == "mapping"
    @test d["storage"]["format"] == "jls"
    @test get(d["metadata"], "composite", false) == false
    v = deserialize_node(d["storage"], dir; trusted=true)
    @test v isa NamedTuple && v == nt
    @test v.fields.b == [1.0, 2.0]

    # sequences: inline when JSON-faithful, jls otherwise, error with array leaves
    d = serialize_node("q1", Any[1, "two", false], dir)
    @test d["storage"]["backend"] == "inline"
    d = serialize_node("q2", (1, "x"), dir; trusted=true)
    @test d["storage"]["format"] == "jls"
    @test deserialize_node(d["storage"], dir; trusted=true) === (1, "x")
    @test_throws PDVSerializationError serialize_node("q3", Any[rand(3)], dir; trusted=true)

    # binary → .bin
    d = serialize_node("b1", UInt8[1, 2, 3], dir; trusted=true)
    @test d["storage"]["format"] == "bin"
    @test deserialize_node(d["storage"], dir; trusted=true) == UInt8[1, 2, 3]

    # DataFrame → .jls
    df = DataFrame(a=[1, 2], b=["x", "y"])
    d = serialize_node("df", df, dir; trusted=true)
    @test d["type"] == "dataframe"
    @test d["storage"]["format"] == "jls"
    @test deserialize_node(d["storage"], dir; trusted=true) == df

    # unknown untrusted rejected; trusted → jls
    struct _Odd
        x::Int
    end
    @test_throws PDVSerializationError serialize_node("u1", _Odd(1), dir)
    d = serialize_node("u1", _Odd(1), dir; trusted=true)
    @test d["storage"]["format"] == "jls"
    @test deserialize_node(d["storage"], dir; trusted=true) == _Odd(1)

    # jls fallback node marks itself
    d = jls_fallback_node("fb", _Odd(2), dir)
    @test d["metadata"]["fallback"] == "jls"

    # folder / module descriptors
    d = serialize_node("f", PDVTree(), dir)
    @test d["storage"]["backend"] == "none" && d["has_children"] == true
    d = serialize_node("mod", PDVModule(module_id="m", name="M", version="2.0"), dir)
    @test d["storage"]["format"] == "module_meta"
    @test d["metadata"]["module_id"] == "m"

    # file-backed node: copies the source into the save dir
    wd = mktempdir()
    uuid = generate_node_uuid()
    script_path = uuid_tree_path(wd, uuid, "s.jl")
    ensure_parent(script_path)
    write(script_path, "function run(pdv_tree; kwargs...) end")
    script = PDVScript(uuid=uuid, filename="s.jl")
    d = serialize_node("scr", script, dir; trusted=true, source_dir=wd)
    @test d["storage"]["format"] == "jl_script"
    @test isfile(uuid_tree_path(dir, uuid, "s.jl"))
    # missing backing file raises the sentinel error
    script_missing = PDVScript(uuid=generate_node_uuid(), filename="ghost.jl")
    err = try
        serialize_node("scr2", script_missing, dir; trusted=true, source_dir=wd)
        nothing
    catch e
        e
    end
    @test err isa PDVSerializationError
    @test startswith(PDVKernel.error_message(err), "File not found:")
end

@testset "inline-JSON admits only the JSON-native fixed point (review)" begin
    dir = mktempdir()
    # Narrow/typed scalars must not inline: a JSON reload would widen them
    # (Int32 → Int64, Float32 → Float64) with an unchanged digest. The .jls
    # path preserves the concrete type exactly.
    for (val, path) in [(Int32(7), "w1"), (Float32(1.5), "w2"), (UInt64(3), "w3"),
                        (Int16(2), "w4"), (Float16(0.5), "w5")]
        d = serialize_node(path, val, dir; trusted=true)
        @test d["storage"]["format"] == "jls"
        @test deserialize_node(d["storage"], dir; trusted=true) === val
    end
    # BitVector is not an `Array` (no .npy path) and must not inline either.
    bv = BitVector([true, false, true])
    d = serialize_node("bv", bv, dir; trusted=true)
    @test d["storage"]["format"] == "jls"
    v = deserialize_node(d["storage"], dir; trusted=true)
    @test v isa BitVector && v == bv
    # Typed containers keep their container type through .jls.
    d = serialize_node("vs", ["a", "b"], dir; trusted=true)
    @test d["storage"]["format"] == "jls"
    @test deserialize_node(d["storage"], dir; trusted=true) isa Vector{String}
    d = serialize_node("di", Dict("a" => 1, "b" => 2), dir; trusted=true)  # Dict{String,Int64}
    @test d["storage"]["format"] == "jls"
    @test deserialize_node(d["storage"], dir; trusted=true) isa Dict{String,Int64}
    # The JSON-native fixed point still inlines: Int64/Float64/Bool/String/
    # nothing inside Vector{Any}/Dict{String,Any}.
    d = serialize_node("ok", Dict{String,Any}("n" => 1, "x" => 2.5, "s" => "t",
                                              "v" => Any[1, "two", false, nothing]), dir)
    @test d["storage"]["backend"] == "inline"

    # Reload TYPES through a real JSON round trip (second review): the index
    # comes back via JSON.parse, whose 1.x object type is NOT a Dict — the
    # loader must materialize inline values to the fixed point, or
    # `cfg isa Dict` breaks after reload and the next save silently reroutes
    # the node to .jls pinning the JSON-internal type into saved data.
    wd2 = mktempdir()
    save2 = mktempdir()
    t1 = PDVTree()
    t1.working_dir = wd2
    t1["cfg"] = Dict{String,Any}("thresh" => 1.5, "name" => "run7")
    t1["seq"] = Any[1, "two", Dict{String,Any}("k" => true)]
    serialize_tree_to_dir(t1, save2)
    parsed_nodes = JSON.parsefile(joinpath(save2, "tree-index.json"))
    t2 = PDVTree()
    t2.working_dir = wd2
    @test isempty(load_tree_index(t2, parsed_nodes; working_dir=save2))
    @test t2["cfg"] isa Dict{String,Any}
    @test t2["cfg"]["thresh"] === 1.5
    @test t2["seq"] isa Vector{Any}
    @test t2["seq"][3] isa Dict{String,Any}
    # …and a resave keeps them inline: no silent .jls migration.
    d = serialize_node("cfg", t2["cfg"], save2)
    @test d["storage"]["backend"] == "inline"
end

@testset "serialization: custom serializers and protocol" begin
    dir = mktempdir()
    clear_serializers!()

    struct _Custom
        payload::String
    end
    register_serializer(_Custom; format="custom_fmt", extension=".cst",
                        save=(obj, p) -> write(p, obj.payload),
                        load=p -> _Custom(read(p, String)),
                        preview=obj -> "custom:" * obj.payload)
    val = _Custom("hi")
    d = serialize_node("c", val, dir)
    @test d["storage"]["format"] == "custom_fmt"
    @test d["metadata"]["serializer"] == PDVKernel.fully_qualified_type_name(_Custom)
    @test d["metadata"]["preview"] == "custom:hi"
    v = deserialize_node(d["storage"], dir)
    @test v isa _Custom && v.payload == "hi"

    # reserved format names rejected
    @test_throws PDVSerializationError register_serializer(_Custom; format="npy",
        save=(o, p) -> nothing, load=p -> nothing)
    clear_serializers!()
end

@testset "checksum" begin
    dir = mktempdir()
    t = PDVTree()
    t["a"] = 1
    t["b"] = [1.0, 2.0]
    t["c.d"] = "text"
    c1 = tree_checksum(t, dir)
    @test length(c1) == 32
    @test c1 == tree_checksum(t, dir)                      # deterministic
    t2 = PDVTree()
    t2["c.d"] = "text"
    t2["b"] = [1.0, 2.0]
    t2["a"] = 1
    @test tree_checksum(t2, dir) == c1                     # order-independent
    t2["a"] = 2
    @test tree_checksum(t2, dir) != c1                     # content-sensitive
    # sequence flavor matters
    @test node_digest((1, 2), dir) != node_digest([1, 2], dir)

    # NamedTuples digest via the mapping walk (sorted field names) and stay
    # stable across a .jls round trip — arrays inside included.
    nt = (alpha = 1.5, fields = (b = [1.0, 2.0], label = "eq"))
    @test node_digest(nt, dir) == node_digest((fields = (label = "eq", b = [1.0, 2.0]), alpha = 1.5), dir)
    io_nt = IOBuffer()
    Serialization.serialize(io_nt, nt)
    seekstart(io_nt)
    @test node_digest(nt, dir) == node_digest(Serialization.deserialize(io_nt), dir)
    @test node_digest(nt, dir) != node_digest(Dict("alpha" => 1.5), dir)

    # unknown structs digest structurally: a contained Dict's hash-table
    # layout (insertion order) must not leak into the digest, and a
    # serialize → deserialize round trip must digest identically.
    struct _CkSol
        params::Dict{String,Any}
    end
    keys14 = ["k$(i)" => i for i in 1:14]
    fwd = Dict{String,Any}()
    for (k, v) in keys14
        fwd[k] = v
    end
    rev = Dict{String,Any}()
    for (k, v) in reverse(keys14)
        rev[k] = v
    end
    @test node_digest(_CkSol(fwd), dir) == node_digest(_CkSol(rev), dir)
    io = IOBuffer()
    Serialization.serialize(io, _CkSol(fwd))
    seekstart(io)
    roundtripped = Serialization.deserialize(io)
    @test node_digest(_CkSol(fwd), dir) == node_digest(roundtripped, dir)
    # arrays of structs digest canonically too
    @test node_digest([_CkSol(fwd)], dir) == node_digest([_CkSol(rev)], dir)
    # file-backed content feeds the hash
    wd = mktempdir()
    uuid = generate_node_uuid()
    p = uuid_tree_path(wd, uuid, "n.md")
    ensure_parent(p)
    write(p, "v1")
    note = PDVNote(uuid=uuid, filename="n.md")
    h1 = node_digest(note, wd)
    write(p, "v2")
    @test node_digest(note, wd) != h1

    # Cyclic object graphs must digest, not stack-overflow (the shape of a
    # Makie Figure: mutable structs and Dicts referencing their ancestors).
    selfref = Dict{String,Any}("x" => 1)
    selfref["me"] = selfref
    d_cyc = node_digest(selfref, dir)
    @test length(d_cyc) == 16
    selfref2 = Dict{String,Any}("x" => 1)
    selfref2["me"] = selfref2
    @test node_digest(selfref2, dir) == d_cyc              # identity-free digest
    selfref2["x"] = 2
    @test node_digest(selfref2, dir) != d_cyc
    mutable struct _CkNode
        value::Int
        next::Union{Nothing,_CkNode}
    end
    a = _CkNode(1, nothing)
    b = _CkNode(2, a)
    a.next = b                                             # 2-cycle through structs
    @test length(node_digest(a, dir)) == 16
    @test node_digest(a, dir) == node_digest(a, dir)
    # shared (diamond) references terminate too and stay content-based
    shared = Dict{String,Any}("k" => 1)
    diamond = Dict{String,Any}("l" => shared, "r" => shared)
    @test length(node_digest(diamond, dir)) == 16
    # a cyclic vector
    v_cyc = Vector{Any}([1])
    push!(v_cyc, v_cyc)
    @test length(node_digest(v_cyc, dir)) == 16
    # raw pointers digest by type only — the address is process-specific
    @test node_digest(Ptr{Cvoid}(UInt(0x1234)), dir) ==
          node_digest(Ptr{Cvoid}(UInt(0x5678)), dir)
    @test node_digest(Ptr{Cvoid}(UInt(0x1234)), dir) !=
          node_digest(Ptr{UInt8}(UInt(0x1234)), dir)
end

@testset "namespace" begin
    ns = Dict{String,Any}(
        "x" => 1, "arr" => rand(3), "d" => Dict("k" => 1),
        "_hidden" => 2, "_pdv_secret" => 3, "pdv_tree" => PDVTree(),
        "f" => sin, "m" => Base,
    )
    vars = pdv_namespace(ns)
    @test haskey(vars, "x") && haskey(vars, "arr") && haskey(vars, "d")
    @test !haskey(vars, "_hidden") && !haskey(vars, "_pdv_secret")
    @test !haskey(vars, "pdv_tree")
    @test !haskey(vars, "f") && !haskey(vars, "m")
    vars = pdv_namespace(ns; include_private=true, include_modules=true,
                         include_callables=true)
    @test haskey(vars, "_hidden") && haskey(vars, "f") && haskey(vars, "m")

    @test vars["arr"]["kind"] == "ndarray"
    @test vars["arr"]["shape"] == [3]
    @test vars["d"]["has_children"] == true

    # lazy inspection
    payload = inspect_namespace(ns; root_name="d")
    @test length(payload["children"]) == 1
    @test payload["children"][1]["name"] == "\"k\""

    ns["obj"] = (a=1, b="x")  # NamedTuple has fields
    payload = inspect_namespace(ns; root_name="obj")
    @test length(payload["children"]) == 2

    ns["seq"] = Any[10, 20, 30]
    payload = inspect_namespace(ns; root_name="seq")
    @test payload["children"][1]["name"] == "[1]"
    deep = inspect_namespace(ns; root_name="seq",
                             path=Any[Dict("kind" => "index", "value" => 2)])
    @test deep["children"] == Any[] || isempty(deep["children"])  # scalar leaf

    # namespace_bindings must keep user `_`-prefixed bindings so
    # `include_private=true` has something to include (review) — the private
    # filter lives in pdv_namespace (presentation), not the snapshot.
    Core.eval(Main, :(_review_probe = 42))
    bindings = namespace_bindings()
    @test get(bindings, "_review_probe", nothing) == 42
    @test !haskey(pdv_namespace(bindings), "_review_probe")
    @test haskey(pdv_namespace(bindings; include_private=true), "_review_probe")
end

@testset "script execution" begin
    wd = mktempdir()
    tree = PDVTree()
    tree.working_dir = wd

    uuid = generate_node_uuid()
    path = uuid_tree_path(wd, uuid, "compute.jl")
    ensure_parent(path)
    write(path, """
        function run(pdv_tree; a::Int = 1, b::Int = 2)
            pdv_tree["result"] = a + b
            return Dict("sum" => a + b)
        end
        """)
    script = PDVScript(uuid=uuid, filename="compute.jl")
    tree["scripts.compute"] = script

    result = run_script(tree, "scripts.compute"; a=3, b=4)
    @test result["sum"] == 7
    @test tree["result"] == 7

    # run_tree_script is the app-facing alias
    result = PDVKernel.run_tree_script(tree, "scripts.compute")
    @test result["sum"] == 3

    # fresh load every run: edit the file, expect new behavior
    write(path, """
        function run(pdv_tree; a::Int = 1, b::Int = 2)
            return Dict("sum" => a * b)
        end
        """)
    result = run_script(tree, "scripts.compute"; a=3, b=4)
    @test result["sum"] == 12

    # missing run() and script errors surface as PDVScriptError
    write(path, "const nothing_here = 1")
    @test_throws PDVScriptError run_script(tree, "scripts.compute")
    write(path, "function run(pdv_tree; kwargs...); error(\"boom\"); end")
    @test_throws PDVScriptError run_script(tree, "scripts.compute")

    # ...and carry the backtrace: the message must point at the failing
    # line in the user's script file, like Python's chained traceback
    # (review M7 — sprint(showerror, err) alone lost every frame).
    err = try
        run_script(tree, "scripts.compute")
        nothing
    catch e
        e
    end
    @test err isa PDVScriptError
    @test occursin("boom", PDVKernel.error_message(err))
    @test occursin("compute.jl", PDVKernel.error_message(err))

    # An interrupt mid-script is a cancellation, not a script error: it
    # must rethrow unchanged so IJulia reports it (and the posterror
    # thread heal sees it), not get relabeled PDVScriptError (review M7).
    write(path, "function run(pdv_tree; kwargs...); throw(InterruptException()); end")
    @test_throws InterruptException run_script(tree, "scripts.compute")
    write(path, "throw(InterruptException())")   # interrupt during include
    @test_throws InterruptException run_script(tree, "scripts.compute")

    # non-script node
    tree["notascript"] = 42
    @test_throws ArgumentError run_script(tree, "notascript")

    # lib exports visible in scripts
    clear_lib_modules!()
    lib_uuid = generate_node_uuid()
    lib_path = uuid_tree_path(wd, lib_uuid, "TestHelperLib.jl")
    ensure_parent(lib_path)
    write(lib_path, """
        module TestHelperLib
        export helper_double
        helper_double(x) = 2x
        end
        """)
    load_lib_file!(lib_path; alias="mymod")
    write(path, """
        function run(pdv_tree; x::Int = 5)
            return Dict("doubled" => helper_double(x))
        end
        """)
    result = run_script(tree, "scripts.compute"; x=21)
    @test result["doubled"] == 42
    clear_lib_modules!()

    # Numeric params from the JSON boundary coerce to the declared kwarg
    # type: tmax=40 (Int64 on the wire) must satisfy tmax::Float64, and an
    # integral Float must satisfy ::Int. Non-integral floats to ::Int still
    # error (lossy), and ::Real needs no coercion.
    write(path, """
        function run(pdv_tree; tmax::Float64 = 10.0, n::Int = 3, r::Real = 1)
            return Dict("tmax" => tmax, "n" => n, "r" => r,
                        "types" => (typeof(tmax), typeof(n), typeof(r)))
        end
        """)
    result = run_script(tree, "scripts.compute"; tmax=40, n=5.0, r=2)
    @test result["tmax"] === 40.0 && result["n"] === 5
    @test result["types"] == (Float64, Int, Int)
    @test_throws PDVScriptError run_script(tree, "scripts.compute"; n=2.5)

    # Round-trip guard (review): an Int above the float type's mantissa
    # width must NOT silently round — it passes through untouched and
    # MethodErrors against the strict annotation. 2^53 itself is exactly
    # representable and still coerces.
    result = run_script(tree, "scripts.compute"; tmax=2^53)
    @test result["tmax"] === 9.007199254740992e15
    @test_throws PDVScriptError run_script(tree, "scripts.compute"; tmax=2^53 + 1)
    write(path, """
        function run(pdv_tree; f::Float32 = 1.0f0, k::Int32 = Int32(1))
            return Dict("f" => f, "k" => k)
        end
        """)
    result = run_script(tree, "scripts.compute"; f=2^24, k=7.0)
    @test result["f"] === Float32(2^24) && result["k"] === Int32(7)
    @test_throws PDVScriptError run_script(tree, "scripts.compute"; f=2^24 + 1)
    # Integral float outside the integer type's range: the InexactError
    # guard leaves it untouched instead of throwing mid-coercion.
    @test_throws PDVScriptError run_script(tree, "scripts.compute"; k=1.0e10)

    # Doc extraction: docstring, block comment (Description preferred),
    # line comment, bare code.
    doc_path = joinpath(wd, "docprobe.jl")
    write(doc_path, "\"\"\"Fit a line to the data.\"\"\"\nfunction run(pdv_tree) end")
    @test PDVKernel.extract_script_doc(doc_path) == "Fit a line to the data."
    # one-liner ending in a multibyte char: byte-index slicing threw
    # StringIndexError here (second review)
    write(doc_path, "\"\"\"Compute Ψ\"\"\"\nfunction run(pdv_tree) end")
    @test PDVKernel.extract_script_doc(doc_path) == "Compute Ψ"
    write(doc_path, "#=\n  myscript.jl\n  Description: Solve the ODE system.\n=#\nrun() = 1")
    @test PDVKernel.extract_script_doc(doc_path) == "Solve the ODE system."
    write(doc_path, "#=\n  first content line\n=#\nrun() = 1")
    @test PDVKernel.extract_script_doc(doc_path) == "first content line"
    write(doc_path, "# quick helper\nrun() = 1")
    @test PDVKernel.extract_script_doc(doc_path) == "quick helper"
    write(doc_path, "function run(pdv_tree) end")
    @test PDVKernel.extract_script_doc(doc_path) === nothing
    @test PDVKernel.extract_script_doc(joinpath(wd, "missing.jl")) === nothing
end

@testset "script params extraction" begin
    dir = mktempdir()
    p = joinpath(dir, "s.jl")
    write(p, """
        #= header comment =#
        function run(pdv_tree; n::Int = 2, x::Float64 = 1.5, s::String = "hi",
                     flag::Bool = true, free = nothing, expr = sqrt(2),
                     mandatory::Int, kwargs...)
            return Dict()
        end
        """)
    params = extract_script_params(p)
    byname = Dict(q["name"] => q for q in params)
    @test byname["n"]["type"] == "int" && byname["n"]["default"] == 2
    @test byname["x"]["type"] == "float" && byname["x"]["default"] == 1.5
    @test byname["s"]["type"] == "str" && byname["s"]["default"] == "hi"
    @test byname["flag"]["type"] == "bool" && byname["flag"]["default"] == true
    @test byname["expr"]["default"] == "sqrt(2)"
    @test byname["mandatory"]["required"] == true
    @test !haskey(byname, "kwargs")
    @test !haskey(byname, "pdv_tree")

    # short-form definition
    write(p, "run(pdv_tree; a=1) = Dict(\"a\" => a)")
    params = extract_script_params(p)
    @test length(params) == 1 && params[1]["name"] == "a"

    # unparsable / missing files
    write(p, "function run(  broken")
    @test extract_script_params(p) == Dict{String,Any}[]
    @test extract_script_params(joinpath(dir, "missing.jl")) == Dict{String,Any}[]
end

@testset "handler registry (pdv_handle)" begin
    clear_handlers!()
    struct _Plottable
        v::Int
    end
    @test !has_handler_for(_Plottable(1))
    calls = []
    register_handler((obj, path, tree) -> push!(calls, (obj, path)), _Plottable)
    @test has_handler_for(_Plottable(1))
    t = PDVTree()
    result = dispatch_handler(_Plottable(7), "a.b", t)
    @test result["dispatched"] == true
    @test calls[1][1].v == 7 && calls[1][2] == "a.b"

    register_handler((obj, path, tree) -> error("kaput"), _Plottable)
    result = dispatch_handler(_Plottable(7), "a.b", t)
    @test result["dispatched"] == false
    @test occursin("kaput", result["error"])

    result = dispatch_handler("no handler", "p", t)
    @test result["dispatched"] == false
    clear_handlers!()

    # Abstract and parametric (UnionAll) registrations match subtypes
    # (second review): the exact-type supertype walk alone never finds them
    # — `_SpecImpl <: _AbstractSpec` walks concrete supertypes only, and
    # `_Param{Float64}`'s chain holds `_Param{Float64}`, never the bare
    # `_Param`. The most-specific registration wins.
    abstract type _AbstractSpec end
    struct _SpecImpl <: _AbstractSpec
        v::Int
    end
    struct _Param{T}
        x::T
    end
    abstract_calls = Any[]
    register_handler((obj, path, tree) -> push!(abstract_calls, path), _AbstractSpec)
    @test has_handler_for(_SpecImpl(1))
    result = dispatch_handler(_SpecImpl(1), "spec.node", t)
    @test result["dispatched"] == true
    @test abstract_calls == ["spec.node"]
    # a more specific concrete registration takes over
    impl_calls = Any[]
    register_handler((obj, path, tree) -> push!(impl_calls, path), _SpecImpl)
    dispatch_handler(_SpecImpl(2), "spec.other", t)
    @test impl_calls == ["spec.other"] && length(abstract_calls) == 1

    param_calls = Any[]
    register_handler((obj, path, tree) -> push!(param_calls, obj.x), _Param)
    @test has_handler_for(_Param(1.5))
    result = dispatch_handler(_Param(1.5), "p.q", t)
    @test result["dispatched"] == true
    @test param_calls == [1.5]
    clear_handlers!()
end

@testset "default handlers" begin
    clear_handlers!()
    t = PDVTree()

    # Numeric arrays always have a default (pdv_handle methods on Base types);
    # without a Makie backend the handler prints a [PDV] notice, never throws.
    @test has_handler_for(rand(5))
    @test has_handler_for(rand(3, 3))
    @test has_handler_for(collect(1:4))            # Vector{Int}
    @test !has_handler_for(Any[1, "x"])            # non-numeric: no default
    local vec_result
    notice = mktemp() do tmppath, tmpio
        redirect_stdout(tmpio) do
            vec_result = dispatch_handler(rand(5), "data.wave", t)
        end
        flush(tmpio)
        read(tmppath, String)
    end
    @test vec_result["dispatched"] == true
    @test occursin("[PDV] Cannot plot 'data.wave'", notice)
    @test occursin("CairoMakie", notice)

    # 0-D/≥3-D numeric arrays: friendly notice with dispatched:true, matching
    # Python's "[PDV] Cannot plot N-D ndarray" (second review parity fix).
    @test has_handler_for(rand(2, 2, 2))
    local nd_result
    nd_notice = mktemp() do tmppath, tmpio
        redirect_stdout(tmpio) do
            nd_result = dispatch_handler(rand(2, 2, 2), "data.cube", t)
        end
        flush(tmpio)
        read(tmppath, String)
    end
    @test nd_result["dispatched"] == true
    @test occursin("3-D ndarray", nd_notice)

    # DataFrames is loaded in the test env → its default registers lazily and
    # dispatch `display`s the value (IJulia forwards displays to the app).
    df = DataFrame(a=[1, 2], b=[3.0, 4.0])
    @test has_handler_for(df)
    struct _CaptureDisplay <: AbstractDisplay
        seen::Vector{Any}
    end
    Base.display(d::_CaptureDisplay, x) = (push!(d.seen, x); nothing)
    cap = _CaptureDisplay(Any[])
    pushdisplay(cap)
    df_result = try
        dispatch_handler(df, "data.table", t)
    finally
        popdisplay(cap)
    end
    @test df_result["dispatched"] == true
    @test length(cap.seen) == 1 && cap.seen[1] === df

    # A user-registered handler always wins over the default, regardless of
    # registration order.
    clear_handlers!()
    user_calls = []
    register_handler((obj, path, tree) -> push!(user_calls, path), DataFrame)
    @test has_handler_for(df)                       # triggers lazy defaults too
    result = dispatch_handler(df, "data.table", t)
    @test result["dispatched"] == true
    @test user_calls == ["data.table"]
    clear_handlers!()
end


@testset "namelist utils" begin
    dir = mktempdir()

    # fortran
    fpath = joinpath(dir, "solver.nml")
    write(fpath, """
        ! Solver settings
        &solver
            n_steps = 100        ! number of steps
            tol = 1.0d-8
            method = 'rk4'
            damping = .true.
            coefs = 1.0, 2.0, 3.0
            reps = 3*0.5
        /
        &grid
            nx = 64
        /
        """)
    @test detect_namelist_format(fpath) == "fortran"
    groups = read_namelist(fpath)
    @test groups["solver"]["n_steps"] == 100
    @test groups["solver"]["tol"] ≈ 1.0e-8
    @test groups["solver"]["method"] == "rk4"
    @test groups["solver"]["damping"] === true
    @test groups["solver"]["coefs"] == [1.0, 2.0, 3.0]
    @test groups["solver"]["reps"] == [0.5, 0.5, 0.5]
    @test groups["grid"]["nx"] == 64

    hints = extract_hints(fpath)
    @test hints["solver"]["n_steps"] == "number of steps"

    types = infer_types(groups)
    @test types["solver"]["n_steps"] == "int"
    @test types["solver"]["tol"] == "float"
    @test types["solver"]["method"] == "str"
    @test types["solver"]["damping"] == "bool"
    @test types["solver"]["coefs"] == "array"

    # write → read round trip
    out = joinpath(dir, "out.nml")
    write_namelist(out, groups)
    groups2 = read_namelist(out)
    @test groups2["solver"]["n_steps"] == 100
    @test groups2["solver"]["coefs"] == [1.0, 2.0, 3.0]
    @test groups2["solver"]["damping"] === true

    # Fortran NULL slots keep their positions (review M5): `1.0, , 3.0`
    # leaves slot 2 untouched — dropping it shifted 3.0 into slot 2, silent
    # physics-input corruption on an open-and-save.
    gpath = joinpath(dir, "gaps.nml")
    write(gpath, """
        &arrays
            x = 1.0, , 3.0
            y(3) = 5.0
            z = 1, 2,
        /
        """)
    gaps = read_namelist(gpath)
    @test gaps["arrays"]["x"] == [1.0, nothing, 3.0]
    @test gaps["arrays"]["y"] == [nothing, nothing, 5.0]   # indexed write pads
    @test gaps["arrays"]["z"] == [1, 2]                    # trailing comma ≠ null slot

    # read↔write is a fixed point: null slots survive any number of
    # open-and-save cycles (the second save used to corrupt `y`).
    gout = joinpath(dir, "gaps-out.nml")
    write_namelist(gout, gaps)
    gaps2 = read_namelist(gout)
    @test gaps2["arrays"]["x"] == [1.0, nothing, 3.0]
    @test gaps2["arrays"]["y"] == [nothing, nothing, 5.0]
    gout2 = joinpath(dir, "gaps-out2.nml")
    write_namelist(gout2, gaps2)
    @test read_namelist(gout2)["arrays"] == gaps["arrays"]

    # toml
    tpath = joinpath(dir, "config.toml")
    write(tpath, """
        # top comment
        [physics]
        gamma = 1.4  # adiabatic index
        label = "run1"
        """)
    groups = read_namelist(tpath)
    @test groups["physics"]["gamma"] ≈ 1.4
    hints = extract_hints(tpath)
    @test hints["physics"]["gamma"] == "adiabatic index"
    write_namelist(joinpath(dir, "o.toml"), groups)
    @test read_namelist(joinpath(dir, "o.toml"))["physics"]["label"] == "run1"
end

@testset "handlers: tree domain" begin
    wd = mktempdir()
    tree = PDVTree()
    tree.working_dir = wd
    tree["data.arr"] = rand(4)
    tree["data.info"] = "hello"
    tree["seq"] = Any[10, Dict("k" => 1)]

    # tree.list at root
    captured = run_handler(tree, "pdv.tree.list", Dict{String,Any}("path" => ""))
    resp = response_of(captured, "pdv.tree.list")
    @test resp["status"] == "ok"
    nodes = resp["payload"]["nodes"]
    @test Set(n["key"] for n in nodes) == Set(["data", "seq"])

    # tree.list nested
    captured = run_handler(tree, "pdv.tree.list", Dict{String,Any}("path" => "data"))
    nodes = response_of(captured, "pdv.tree.list")["payload"]["nodes"]
    byname = Dict(n["key"] => n for n in nodes)
    @test byname["arr"]["type"] == "ndarray"
    @test byname["info"]["type"] == "text"

    # tree.list on a sequence: 1-based keys, opaque parent
    captured = run_handler(tree, "pdv.tree.list", Dict{String,Any}("path" => "seq"))
    nodes = response_of(captured, "pdv.tree.list")["payload"]["nodes"]
    @test [n["key"] for n in nodes] == ["1", "2"]
    @test all(n["parent_is_opaque"] == true for n in nodes)

    # tree.list on a NamedTuple: expandable like a nested dict, keyed by
    # field name, read-only children (§5.14 — e.g. a solver's results bundle)
    tree["nt"] = (alpha = 1.5, fields = (b = [1.0, 2.0], label = "eq"))
    captured = run_handler(tree, "pdv.tree.list", Dict{String,Any}("path" => ""))
    root_nodes = response_of(captured, "pdv.tree.list")["payload"]["nodes"]
    nt_node = only(n for n in root_nodes if n["key"] == "nt")
    @test nt_node["type"] == "mapping"
    @test nt_node["has_children"] == true
    @test nt_node["preview"] == "namedtuple (2 keys)"
    @test nt_node["python_type"] == "Core.NamedTuple"
    captured = run_handler(tree, "pdv.tree.list", Dict{String,Any}("path" => "nt"))
    nodes = response_of(captured, "pdv.tree.list")["payload"]["nodes"]
    byname = Dict(n["key"] => n for n in nodes)
    @test Set(keys(byname)) == Set(["alpha", "fields"])
    @test byname["fields"]["has_children"] == true
    @test all(n["parent_is_opaque"] == true for n in nodes)

    # dot-path traversal through NamedTuple fields (get + tree.get)
    @test tree["nt.fields.b"] == [1.0, 2.0]
    @test tree["nt.fields.label"] == "eq"
    @test haskey(tree, "nt.fields.b")
    @test !haskey(tree, "nt.fields.nope")
    captured = run_handler(tree, "pdv.tree.get", Dict{String,Any}("path" => "nt.fields.label"))
    @test occursin("eq", response_of(captured, "pdv.tree.get")["payload"]["value"])

    # tree.list errors
    captured = run_handler(tree, "pdv.tree.list", Dict{String,Any}("path" => "nope"))
    @test response_of(captured, "pdv.tree.list")["status"] == "error"
    captured = run_handler(tree, "pdv.tree.list", Dict{String,Any}("path" => "data.info"))
    resp = response_of(captured, "pdv.tree.list")
    @test resp["status"] == "error"
    @test resp["payload"]["code"] == "tree.not_a_folder"

    # tree.get value mode
    captured = run_handler(tree, "pdv.tree.get", Dict{String,Any}("path" => "data.info"))
    resp = response_of(captured, "pdv.tree.get")
    @test resp["payload"]["type"] == "text"
    @test occursin("hello", resp["payload"]["value"])
    captured = run_handler(tree, "pdv.tree.get",
                           Dict{String,Any}("path" => "data.info", "mode" => "metadata"))
    @test !haskey(response_of(captured, "pdv.tree.get")["payload"], "value")

    # giant value repr is capped
    tree["big"] = repeat("z", 50_000)
    captured = run_handler(tree, "pdv.tree.get", Dict{String,Any}("path" => "big"))
    resp = response_of(captured, "pdv.tree.get")
    @test resp["payload"]["value_truncated"] == true
    @test length(resp["payload"]["value"]) < 11_000

    # create_node
    captured = run_handler(tree, "pdv.tree.create_node",
                           Dict{String,Any}("parent_path" => "data", "name" => "sub"))
    @test response_of(captured, "pdv.tree.create_node")["payload"]["created"] == true
    @test tree["data.sub"] isa PDVTree
    captured = run_handler(tree, "pdv.tree.create_node",
                           Dict{String,Any}("parent_path" => "", "name" => "bad.dot"))
    @test response_of(captured, "pdv.tree.create_node")["payload"]["code"] == "tree.invalid_name"
    captured = run_handler(tree, "pdv.tree.create_node",
                           Dict{String,Any}("parent_path" => "data", "name" => "sub"))
    @test response_of(captured, "pdv.tree.create_node")["payload"]["code"] == "tree.already_exists"

    # rename
    captured = run_handler(tree, "pdv.tree.rename",
                           Dict{String,Any}("path" => "data.info", "new_name" => "renamed"))
    @test response_of(captured, "pdv.tree.rename")["payload"]["renamed"] == true
    @test tree["data.renamed"] == "hello"
    @test !haskey(tree, "data.info")

    # move
    captured = run_handler(tree, "pdv.tree.move",
                           Dict{String,Any}("path" => "data.renamed", "new_path" => "moved"))
    @test response_of(captured, "pdv.tree.move")["payload"]["moved"] == true
    @test tree["moved"] == "hello"
    # circular move rejected
    captured = run_handler(tree, "pdv.tree.move",
                           Dict{String,Any}("path" => "data", "new_path" => "data.sub.x"))
    @test response_of(captured, "pdv.tree.move")["payload"]["code"] == "tree.circular_move"

    # rename/move of a sequence child rejected (review): set_quiet! would
    # replace the whole Vector with a PDVTree holding only that child. The
    # renderer never offers these; MCP agent tools reach them directly.
    tree["vec"] = Any[10, 20, 30]
    captured = run_handler(tree, "pdv.tree.rename",
                           Dict{String,Any}("path" => "vec.2", "new_name" => "elem"))
    @test response_of(captured, "pdv.tree.rename")["payload"]["code"] == "tree.not_a_container"
    @test tree["vec"] == Any[10, 20, 30]           # vector untouched
    captured = run_handler(tree, "pdv.tree.move",
                           Dict{String,Any}("path" => "vec.2", "new_path" => "loose"))
    @test response_of(captured, "pdv.tree.move")["payload"]["code"] == "tree.not_a_container"
    @test tree["vec"] == Any[10, 20, 30]
    @test !haskey(tree, "loose")

    # duplicate (with file-backed node getting a fresh uuid)
    uuid = generate_node_uuid()
    fpath = uuid_tree_path(wd, uuid, "n.md")
    ensure_parent(fpath)
    write(fpath, "note body")
    tree["note"] = PDVNote(uuid=uuid, filename="n.md")
    captured = run_handler(tree, "pdv.tree.duplicate",
                           Dict{String,Any}("path" => "note", "new_path" => "note2"))
    @test response_of(captured, "pdv.tree.duplicate")["payload"]["duplicated"] == true
    @test tree["note2"] isa PDVNote
    @test tree["note2"].uuid != tree["note"].uuid
    @test isfile(uuid_tree_path(wd, tree["note2"].uuid, "n.md"))

    # delete
    captured = run_handler(tree, "pdv.tree.delete", Dict{String,Any}("path" => "moved"))
    @test response_of(captured, "pdv.tree.delete")["payload"]["deleted"] == true
    @test !haskey(tree, "moved")

    # resolve_file
    captured = run_handler(tree, "pdv.tree.resolve_file", Dict{String,Any}("path" => "note"))
    resp = response_of(captured, "pdv.tree.resolve_file")
    @test resp["payload"]["file_path"] == uuid_tree_path(wd, tree["note"].uuid, "n.md")
    captured = run_handler(tree, "pdv.tree.resolve_file", Dict{String,Any}("path" => "seq"))
    @test response_of(captured, "pdv.tree.resolve_file")["payload"]["code"] == "tree.not_a_file"
end

@testset "handlers: script/note/gui/file register + params" begin
    wd = mktempdir()
    tree = PDVTree()
    tree.working_dir = wd

    uuid = generate_node_uuid()
    spath = uuid_tree_path(wd, uuid, "fit.jl")
    ensure_parent(spath)
    write(spath, "# Fit amplitudes.\nfunction run(pdv_tree; amplitude::Float64 = 1.0) Dict() end")

    captured = run_handler(tree, "pdv.script.register", Dict{String,Any}(
        "parent_path" => "scripts", "name" => "fit", "uuid" => uuid,
        "filename" => "fit.jl", "language" => "julia"))
    @test response_of(captured, "pdv.script.register")["payload"]["path"] == "scripts.fit"
    @test tree["scripts.fit"] isa PDVScript
    # doc preview extracted from the leading comment at register time
    @test tree["scripts.fit"].doc == "Fit amplitudes."
    @test PDVKernel.preview(tree["scripts.fit"]) == "Fit amplitudes."

    captured = run_handler(tree, "pdv.script.params",
                           Dict{String,Any}("path" => "scripts.fit"))
    params = response_of(captured, "pdv.script.params")["payload"]["params"]
    @test length(params) == 1 && params[1]["name"] == "amplitude"
    # params re-reads the file — the doc refreshes with it
    write(spath, "# Fit amplitudes v2.\nfunction run(pdv_tree; amplitude::Float64 = 1.0) Dict() end")
    run_handler(tree, "pdv.script.params", Dict{String,Any}("path" => "scripts.fit"))
    @test tree["scripts.fit"].doc == "Fit amplitudes v2."

    # missing field → validation error
    captured = run_handler(tree, "pdv.script.register",
                           Dict{String,Any}("parent_path" => "scripts", "name" => "x"))
    resp = response_of(captured, "pdv.script.register")
    @test resp["status"] == "error"
    @test resp["payload"]["code"] == "script.missing_uuid"

    # note.register
    nuuid = generate_node_uuid()
    captured = run_handler(tree, "pdv.note.register", Dict{String,Any}(
        "parent_path" => "", "name" => "intro", "uuid" => nuuid, "filename" => "intro.md"))
    @test tree["intro"] isa PDVNote

    # gui.register attaches to module parent
    tree["mymod"] = PDVModule(module_id="mid", name="My", version="1.0")
    guuid = generate_node_uuid()
    captured = run_handler(tree, "pdv.gui.register", Dict{String,Any}(
        "parent_path" => "mymod", "name" => "gui", "uuid" => guuid,
        "filename" => "gui.gui.json", "module_id" => "mid"))
    @test tree["mymod.gui"] isa PDVGui
    @test tree["mymod"].gui === tree["mymod.gui"]

    # file.register: namelist
    fuuid = generate_node_uuid()
    captured = run_handler(tree, "pdv.file.register", Dict{String,Any}(
        "tree_path" => "mymod", "filename" => "solver.nml",
        "node_type" => "namelist", "uuid" => fuuid))
    @test tree["mymod.solver"] isa PDVNamelist

    # file.register: dotfiles must terminate (second review — the stem
    # strip loop spun forever on leading-dot names, pegging comm dispatch)
    # and the surviving dot must not become a tree-path separator.
    captured = run_handler(tree, "pdv.file.register", Dict{String,Any}(
        "tree_path" => "", "filename" => ".bashrc",
        "node_type" => "file", "uuid" => generate_node_uuid()))
    @test tree["_bashrc"] isa PDVFile
    captured = run_handler(tree, "pdv.file.register", Dict{String,Any}(
        "tree_path" => "", "filename" => ".env.local",
        "node_type" => "file", "uuid" => generate_node_uuid()))
    @test tree["_env"] isa PDVFile
    # double extensions still strip to the bare stem
    captured = run_handler(tree, "pdv.file.register", Dict{String,Any}(
        "tree_path" => "", "filename" => "layout.gui.json",
        "node_type" => "file", "uuid" => generate_node_uuid()))
    @test tree["layout"] isa PDVFile
end

@testset "handlers: namelist read/write" begin
    wd = mktempdir()
    tree = PDVTree()
    tree.working_dir = wd

    uuid = generate_node_uuid()
    npath = uuid_tree_path(wd, uuid, "solver.nml")
    ensure_parent(npath)
    write(npath, "&solver\n    nx = 32   ! grid points\n/\n")
    tree["nml"] = PDVNamelist(uuid=uuid, filename="solver.nml", format="auto")

    captured = run_handler(tree, "pdv.namelist.read", Dict{String,Any}("tree_path" => "nml"))
    resp = response_of(captured, "pdv.namelist.read")
    @test resp["status"] == "ok"
    @test resp["payload"]["groups"]["solver"]["nx"] == 32
    @test resp["payload"]["format"] == "fortran"
    @test resp["payload"]["hints"]["solver"]["nx"] == "grid points"

    captured = run_handler(tree, "pdv.namelist.write", Dict{String,Any}(
        "tree_path" => "nml",
        "data" => Dict("solver" => Dict("nx" => 64, "label" => "hi"))))
    @test response_of(captured, "pdv.namelist.write")["payload"]["success"] == true
    groups = read_namelist(npath)
    @test groups["solver"]["nx"] == 64 && groups["solver"]["label"] == "hi"

    captured = run_handler(tree, "pdv.namelist.read", Dict{String,Any}("tree_path" => "missing"))
    @test response_of(captured, "pdv.namelist.read")["payload"]["code"] == "namelist.path_not_found"
end

@testset "handlers: project save/load round trip" begin
    clear_autosave_cache!()
    wd = mktempdir()
    save_dir = mktempdir()
    tree = PDVTree()
    tree.working_dir = wd

    tree["data.arr"] = rand(6)
    tree["data.mat"] = rand(2, 3)
    tree["config"] = Dict("mode" => "fast", "n" => 3)
    tree["notes_text"] = "hello project"
    tree["deep.tuple"] = (1, "x")

    suuid = generate_node_uuid()
    spath = uuid_tree_path(wd, suuid, "an.jl")
    ensure_parent(spath)
    write(spath, "function run(pdv_tree; kwargs...) Dict() end")
    tree["scripts.an"] = PDVScript(uuid=suuid, filename="an.jl")

    m = PDVModule(module_id="tm", name="TestMod", version="1.2.3")
    tree["tm"] = m
    luuid = generate_node_uuid()
    lpath = uuid_tree_path(wd, luuid, "TmLib.jl")
    ensure_parent(lpath)
    write(lpath, "module TmLib end")
    tree["tm.lib.TmLib"] = PDVLib(uuid=luuid, filename="TmLib.jl", module_id="tm",
                                  source_rel_path="lib/TmLib.jl")

    captured = run_handler(tree, "pdv.project.save",
                           Dict{String,Any}("save_dir" => save_dir))
    resp = response_of(captured, "pdv.project.save")
    @test resp["status"] == "ok"
    payload = resp["payload"]
    @test payload["aborted"] == false

    # Progress contract: an immediate 0/total emission (the renderer's bar
    # must appear before the walk — a small tree's only other emission used
    # to be current == total, which the renderer treats as "clear the bar"),
    # then per-node emissions for small trees, ending at total/total.
    progress = [m["payload"] for m in captured if m["type"] == "pdv.progress"]
    @test !isempty(progress)
    @test all(p["operation"] == "save" && p["phase"] == "Serializing" for p in progress)
    @test progress[1]["current"] == 0
    @test allequal(p["total"] for p in progress)
    @test progress[end]["current"] == progress[end]["total"]
    @test length(progress) >= 3          # 0, …every node…, total
    @test payload["node_count"] > 5
    @test length(payload["checksum"]) == 32
    @test isfile(joinpath(save_dir, "tree-index.json"))
    # module sync payloads
    @test length(payload["module_manifests"]) == 1
    manifest = payload["module_manifests"][1]
    @test manifest["module_id"] == "tm" && manifest["language"] == "julia"
    @test any(e -> e["type"] == "lib", manifest["entries"])
    @test length(payload["module_owned_files"]) == 1
    @test payload["module_owned_files"][1]["source_rel_path"] == "lib/TmLib.jl"

    pre_save_checksum = payload["checksum"]

    # load into a fresh tree (fresh "session" working dir gets the files
    # copied by the app in production; here we load directly from save_dir)
    tree2 = PDVTree()
    tree2.working_dir = save_dir
    captured = run_handler(tree2, "pdv.project.load",
                           Dict{String,Any}("save_dir" => save_dir))
    resp = response_of(captured, "pdv.project.load")
    @test resp["status"] == "ok"
    @test resp["payload"]["node_count"] > 5
    @test isempty(resp["payload"]["skipped_nodes"])
    pushes = filter(m -> m["type"] == "pdv.project.loaded", captured)
    @test length(pushes) == 1

    @test tree2["data.arr"] == tree["data.arr"]
    @test tree2["data.mat"] == tree["data.mat"]
    @test tree2["config"]["mode"] == "fast"
    @test tree2["notes_text"] == "hello project"
    @test tree2["deep.tuple"] === (1, "x")
    @test tree2["scripts.an"] isa PDVScript
    @test tree2["tm"] isa PDVModule
    @test tree2["tm"].name == "TestMod"
    @test tree2["tm.lib.TmLib"] isa PDVLib
    @test tree2["tm.lib.TmLib"].source_rel_path == "lib/TmLib.jl"

    # checksum survives the round trip
    @test tree_checksum(tree2, save_dir) == pre_save_checksum

    # save abort on missing backing file
    tree["ghost"] = PDVScript(uuid=generate_node_uuid(), filename="ghost.jl")
    captured = run_handler(tree, "pdv.project.save",
                           Dict{String,Any}("save_dir" => save_dir))
    payload = response_of(captured, "pdv.project.save")["payload"]
    @test payload["aborted"] == true
    @test payload["missing_files"] == ["ghost"]
    delete!(tree, "ghost")

    # a value even Serialization refuses is skipped and recorded in
    # failed_nodes — it must never abort the whole save
    tree["poison"] = _Unserializable()
    save_dir2 = mktempdir()
    captured = run_handler(tree, "pdv.project.save",
                           Dict{String,Any}("save_dir" => save_dir2))
    payload = response_of(captured, "pdv.project.save")["payload"]
    @test payload["aborted"] == false
    @test length(payload["failed_nodes"]) == 1
    @test payload["failed_nodes"][1]["path"] == "poison"
    @test payload["failed_nodes"][1]["preserved"] == false  # no prior save to keep
    @test isfile(joinpath(save_dir2, "tree-index.json"))
    index = JSON.parsefile(joinpath(save_dir2, "tree-index.json"))
    @test !any(n -> n["path"] == "poison", index)          # skipped, not written
    @test any(n -> n["path"] == "notes_text", index)       # the rest saved fine
    delete!(tree, "poison")
    clear_autosave_cache!()
end

@testset "non-String-keyed Dicts persist whole as .jls (review B2+M6)" begin
    clear_autosave_cache!()
    wd = mktempdir()
    save_dir = mktempdir()
    tree = PDVTree()
    tree.working_dir = wd
    tree["shots"] = Dict(1 => [1.0, 2.0, 3.0], 2 => [4.0, 5.0])  # Int keys + array leaves
    tree["params"] = Dict(:alpha => [0.1, 0.2], :beta => 3)      # Symbol keys + array leaf

    captured = run_handler(tree, "pdv.project.save",
                           Dict{String,Any}("save_dir" => save_dir))
    payload = response_of(captured, "pdv.project.save")["payload"]
    @test payload["aborted"] == false     # B2: Int keys used to abort every save
    @test isempty(payload["failed_nodes"])

    # no composite split — one whole-jls leaf, no stringified child paths
    index = JSON.parsefile(joinpath(save_dir, "tree-index.json"))
    shots_node = only(filter(n -> n["path"] == "shots", index))
    @test get(get(shots_node, "metadata", Dict{String,Any}()), "composite", false) == false
    @test shots_node["storage"]["format"] == "jls"
    @test !any(n -> startswith(n["path"], "shots."), index)

    # M6: keys survive the round trip with their original types
    tree2 = PDVTree()
    tree2.working_dir = save_dir
    run_handler(tree2, "pdv.project.load", Dict{String,Any}("save_dir" => save_dir))
    @test haskey(tree2["shots"], 1) && tree2["shots"][1] == [1.0, 2.0, 3.0]
    @test haskey(tree2["params"], :alpha) && tree2["params"][:alpha] == [0.1, 0.2]
    clear_autosave_cache!()
end

@testset "failed node keeps its last good snapshot (review M1)" begin
    clear_autosave_cache!()
    wd = mktempdir()
    save_dir = mktempdir()
    tree = PDVTree()
    tree.working_dir = wd
    tree["vol"] = rand(64)   # file-backed (.npy) on the first save
    tree["ok"] = 1

    captured = run_handler(tree, "pdv.project.save",
                           Dict{String,Any}("save_dir" => save_dir))
    payload = response_of(captured, "pdv.project.save")["payload"]
    @test payload["aborted"] == false && isempty(payload["failed_nodes"])
    index1 = JSON.parsefile(joinpath(save_dir, "tree-index.json"))
    vol_uuid = only(filter(n -> n["path"] == "vol", index1))["uuid"]
    @test isdir(joinpath(save_dir, "tree", vol_uuid))
    saved_vol = copy(tree["vol"])

    # value becomes unserializable; the save must keep the previous snapshot
    # instead of dropping the node from the index (which let the orphan
    # purge destroy the last good copy)
    tree["vol"] = _Unserializable()
    captured = run_handler(tree, "pdv.project.save",
                           Dict{String,Any}("save_dir" => save_dir))
    payload = response_of(captured, "pdv.project.save")["payload"]
    @test payload["aborted"] == false
    @test length(payload["failed_nodes"]) == 1
    @test payload["failed_nodes"][1]["path"] == "vol"
    @test payload["failed_nodes"][1]["preserved"] == true
    index2 = JSON.parsefile(joinpath(save_dir, "tree-index.json"))
    @test only(filter(n -> n["path"] == "vol", index2))["uuid"] == vol_uuid
    @test isdir(joinpath(save_dir, "tree", vol_uuid))   # purge kept the snapshot

    tree2 = PDVTree()
    tree2.working_dir = save_dir
    run_handler(tree2, "pdv.project.load", Dict{String,Any}("save_dir" => save_dir))
    @test tree2["vol"] == saved_vol                      # last good copy restored
    clear_autosave_cache!()
end

@testset "handlers: autosave cache" begin
    clear_autosave_cache!()
    wd = mktempdir()
    save_dir = mktempdir()
    tree = PDVTree()
    tree.working_dir = wd
    tree["a"] = rand(512)
    tree["b"] = rand(16)

    captured = run_handler(tree, "pdv.project.save", Dict{String,Any}("save_dir" => save_dir))
    payload = response_of(captured, "pdv.project.save")["payload"]
    @test payload["autosave_cache_hits"] == 0

    # unchanged nodes hit the cache on the next save
    captured = run_handler(tree, "pdv.project.save", Dict{String,Any}("save_dir" => save_dir))
    payload = response_of(captured, "pdv.project.save")["payload"]
    @test payload["autosave_cache_hits"] == 2

    # a changed node misses; the other still hits
    tree["a"] = rand(512)
    captured = run_handler(tree, "pdv.project.save", Dict{String,Any}("save_dir" => save_dir))
    payload = response_of(captured, "pdv.project.save")["payload"]
    @test payload["autosave_cache_hits"] == 1

    # clear_cache flag wipes before saving
    captured = run_handler(tree, "pdv.project.save", Dict{String,Any}(
        "save_dir" => save_dir, "clear_cache" => true))
    payload = response_of(captured, "pdv.project.save")["payload"]
    @test payload["autosave_cache_hits"] == 0

    # eager clear via dedicated message
    captured = run_handler(tree, "pdv.project.clear_autosave_cache")
    @test response_of(captured, "pdv.project.clear_autosave_cache")["status"] == "ok"
    @test isempty(_autosave_cache[])

    # deleted paths are pruned from the cache after a save
    run_handler(tree, "pdv.project.save", Dict{String,Any}("save_dir" => save_dir))
    @test haskey(_autosave_cache[], "b")
    delete!(tree, "b")
    run_handler(tree, "pdv.project.save", Dict{String,Any}("save_dir" => save_dir))
    @test !haskey(_autosave_cache[], "b")
    clear_autosave_cache!()
end

@testset "handlers: modules domain" begin
    wd = mktempdir()
    tree = PDVTree()
    tree.working_dir = wd

    # create_empty seeds scripts/lib/plots
    captured = run_handler(tree, "pdv.module.create_empty", Dict{String,Any}(
        "id" => "toy", "name" => "Toy", "version" => "0.1.0", "language" => "julia"))
    @test response_of(captured, "pdv.module.create_empty")["payload"]["path"] == "toy"
    @test tree["toy"] isa PDVModule
    @test tree["toy.scripts"] isa PDVTree && tree["toy.lib"] isa PDVTree &&
          tree["toy.plots"] isa PDVTree
    captured = run_handler(tree, "pdv.module.create_empty", Dict{String,Any}("id" => "toy"))
    @test response_of(captured, "pdv.module.create_empty")["payload"]["code"] == "module.alias_exists"

    # update patches mutable fields only
    captured = run_handler(tree, "pdv.module.update", Dict{String,Any}(
        "alias" => "toy", "name" => "Toy2", "version" => "0.2.0"))
    resp = response_of(captured, "pdv.module.update")
    @test resp["payload"]["name"] == "Toy2"
    @test tree["toy"].version == "0.2.0"

    # module.register with v4 index mounts the subtree
    suuid = generate_node_uuid()
    spath = uuid_tree_path(wd, suuid, "act.jl")
    ensure_parent(spath)
    write(spath, "function run(pdv_tree; kwargs...) Dict(\"ok\" => true) end")
    index = Any[
        Dict{String,Any}("id" => "scripts", "path" => "scripts", "key" => "scripts",
                         "parent_path" => "", "type" => "folder", "has_children" => true,
                         "storage" => Dict{String,Any}("backend" => "none", "format" => "none")),
        Dict{String,Any}("id" => "scripts.act", "path" => "scripts.act", "key" => "act",
                         "parent_path" => "scripts", "type" => "script",
                         "uuid" => suuid,
                         "storage" => Dict{String,Any}(
                             "backend" => "local_file", "uuid" => suuid,
                             "filename" => "act.jl", "format" => "jl_script"),
                         "metadata" => Dict{String,Any}("language" => "julia")),
    ]
    captured = run_handler(tree, "pdv.module.register", Dict{String,Any}(
        "path" => "npend", "module_id" => "npend", "name" => "NPend",
        "version" => "2.0.0", "module_index" => index))
    @test response_of(captured, "pdv.module.register")["status"] == "ok"
    @test tree["npend"] isa PDVModule
    @test tree["npend.scripts.act"] isa PDVScript
    @test tree["npend.scripts.act"].module_id == "npend"
    # re-register updates in place, keeps children
    tree["npend.outputs"] = PDVTree()
    tree["npend.outputs.r"] = 42
    captured = run_handler(tree, "pdv.module.register", Dict{String,Any}(
        "path" => "npend", "module_id" => "npend", "name" => "NPend Renamed",
        "version" => "2.1.0", "module_index" => index))
    @test tree["npend"].name == "NPend Renamed"
    @test tree["npend.outputs.r"] == 42

    # modules.setup loads libs into Main and reports the handler registry
    clear_lib_modules!()
    luuid = generate_node_uuid()
    lpath = uuid_tree_path(wd, luuid, "SetupTestLib.jl")
    ensure_parent(lpath)
    write(lpath, """
        module SetupTestLib
        export setup_marker
        setup_marker() = :loaded
        end
        """)
    tree["npend.lib.SetupTestLib"] = PDVLib(uuid=luuid, filename="SetupTestLib.jl",
                                            module_id="npend")
    captured = run_handler(tree, "pdv.modules.setup", Dict{String,Any}(
        "modules" => Any[Dict{String,Any}("alias" => "npend")]))
    resp = response_of(captured, "pdv.modules.setup")
    @test resp["status"] == "ok"
    @test isdefined(Main, :SetupTestLib)

    # reload_libs re-includes
    write(lpath, """
        module SetupTestLib
        export setup_marker
        setup_marker() = :reloaded
        end
        """)
    captured = run_handler(tree, "pdv.module.reload_libs",
                           Dict{String,Any}("alias" => "npend"))
    resp = response_of(captured, "pdv.module.reload_libs")
    @test "SetupTestLib" in resp["payload"]["reloaded"]
    @test Base.invokelatest(Main.SetupTestLib.setup_marker) == :reloaded
    # non-module alias short-circuits cheaply
    captured = run_handler(tree, "pdv.module.reload_libs",
                           Dict{String,Any}("alias" => "not_a_module"))
    @test response_of(captured, "pdv.module.reload_libs")["payload"]["reloaded"] == Any[]

    # handler.invoke
    clear_handlers!()
    register_handler((obj, path, t) -> nothing, Int)
    tree["answer"] = 42
    captured = run_handler(tree, "pdv.handler.invoke", Dict{String,Any}("path" => "answer"))
    @test response_of(captured, "pdv.handler.invoke")["payload"]["dispatched"] == true
    clear_handlers!()
    clear_lib_modules!()
end

@testset "handlers: introspection" begin
    wd = mktempdir()
    tree = PDVTree()
    tree.working_dir = wd
    uuid = generate_node_uuid()
    p = uuid_tree_path(wd, uuid, "s.jl")
    ensure_parent(p)
    write(p, "function run(pdv_tree; kwargs...) end")
    tree["s"] = PDVScript(uuid=uuid, filename="s.jl")

    # pdv.help on a PDVKernel symbol
    captured = run_handler(tree, "pdv.help",
                           Dict{String,Any}("symbol" => "PDVKernel.add_file"))
    resp = response_of(captured, "pdv.help")
    @test resp["status"] == "ok"
    @test resp["payload"]["kind"] == "function"
    @test resp["payload"]["doc"] !== nothing
    captured = run_handler(tree, "pdv.help", Dict{String,Any}("symbol" => "NoSuchThing99"))
    @test response_of(captured, "pdv.help")["status"] == "error"

    # forward resolve
    captured = run_handler(tree, "pdv.tree.resolve_path", Dict{String,Any}("path" => "s"))
    resp = response_of(captured, "pdv.tree.resolve_path")
    @test resp["payload"]["file_path"] == uuid_tree_path(wd, uuid, "s.jl")
    # reverse resolve
    captured = run_handler(tree, "pdv.tree.resolve_path",
                           Dict{String,Any}("path" => uuid_tree_path(wd, uuid, "s.jl")))
    resp = response_of(captured, "pdv.tree.resolve_path")
    @test resp["payload"]["tree_paths"] == ["s"]
end

@testset "handlers: namespace domain" begin
    tree = PDVTree()
    Core.eval(Main, :(pdv_test_var_xyz = [1.0, 2.0, 3.0]))
    captured = run_handler(tree, "pdv.namespace.query")
    resp = response_of(captured, "pdv.namespace.query")
    @test resp["status"] == "ok"
    @test haskey(resp["payload"]["variables"], "pdv_test_var_xyz")

    captured = run_handler(tree, "pdv.namespace.inspect",
                           Dict{String,Any}("root_name" => "pdv_test_var_xyz"))
    resp = response_of(captured, "pdv.namespace.inspect")
    @test length(resp["payload"]["children"]) == 3
end

@testset "dispatch: unknown type and version check" begin
    tree = PDVTree()
    captured = run_handler(tree, "pdv.bogus.type")
    @test captured[1]["type"] == "pdv.bogus.type.response"
    @test captured[1]["status"] == "error"
    @test captured[1]["payload"]["code"] == "protocol.unknown_type"

    # incompatible major version dropped by on_comm_message
    with_active_tree(tree) do
        captured = capture_messages() do
            bad = request("pdv.tree.list", Dict{String,Any}("path" => ""))
            bad["pdv_version"] = "99.0.0"
            @test_logs (:warn, r"Incompatible PDV version") PDVKernel.on_comm_message(
                Dict("content" => Dict("data" => bad)))
        end
        @test isempty(captured)
    end
end

@testset "query server threaded-mode gate" begin
    # Threaded mode needs a SPARE interactive thread: the poll loop must
    # never take a default-pool thread (`@threads :static` pins one task per
    # default thread — a resident loop there deadlocks every :static loop;
    # PR #347 review B1) and must not share the main task's only interactive
    # thread. Under Pkg.test (single-threaded) the gate must say no.
    if Threads.nthreads(:interactive) == 0
        # Pkg.test default: no interactive pool at all → cooperative only.
        @test !PDVKernel._can_run_threaded()
    elseif Threads.threadpool() === :interactive
        # App-style config (main task interactive): a spare thread beyond
        # the main task's is required — `--threads=auto,1` no longer
        # qualifies, `--threads=auto,2` does.
        @test PDVKernel._can_run_threaded() ==
              (Threads.nthreads(:interactive) >= 2)
    else
        # Main task on the default pool: any interactive thread is spare.
        @test PDVKernel._can_run_threaded()
    end
end

@testset "query server over ZMQ" begin
    wd = mktempdir()
    tree = PDVTree()
    tree.working_dir = wd
    tree["qdata"] = [1.0, 2.0]

    port = rand(30000:40000)
    server = QueryServer(port)
    with_active_tree(tree) do
        start!(server)
        sock = ZMQ.Socket(ZMQ.REQ)
        try
            ZMQ.connect(sock, "tcp://127.0.0.1:$port")
            # allowed query
            req = JSON.json(request("pdv.tree.list", Dict{String,Any}("path" => "")))
            ZMQ.send(sock, req)
            resp = JSON.parse(String(ZMQ.recv(sock)))
            @test resp["status"] == "ok"
            @test any(n -> n["key"] == "qdata", resp["payload"]["nodes"])
            # disallowed (mutating) type rejected
            ZMQ.send(sock, JSON.json(request("pdv.tree.delete",
                                             Dict{String,Any}("path" => "qdata"))))
            resp = JSON.parse(String(ZMQ.recv(sock)))
            @test resp["status"] == "error"
            @test resp["payload"]["code"] == "query.not_allowed"
            @test haskey(tree, "qdata")
            # malformed JSON produces a structured error, not a hang
            ZMQ.send(sock, "{not json")
            resp = JSON.parse(String(ZMQ.recv(sock)))
            @test resp["status"] == "error"
        finally
            close(sock)
            stop!(server)
        end
    end
end

@testset "query cache (busy-time tree snapshot)" begin
    wd = mktempdir()
    tree = PDVTree()
    tree.working_dir = wd
    tree["data.arr"] = [1.0, 2.0, 3.0]
    tree["config"] = Dict{String,Any}("mode" => "fast", "sub" => Dict("k" => 1))
    tree["note_text"] = "hello"

    PDVKernel.clear_query_cache!()
    @test PDVKernel.cached_tree_listing("") === nothing   # no snapshot yet

    PDVKernel.rebuild_query_cache!(tree)
    root = PDVKernel.cached_tree_listing("")
    @test root !== nothing
    @test sort([n["key"] for n in root]) == ["config", "data", "note_text"]
    # nested levels are pre-listed, including plain-Dict composites
    @test any(n -> n["key"] == "arr", PDVKernel.cached_tree_listing("data"))
    sub = PDVKernel.cached_tree_listing("config.sub")
    @test sub !== nothing && sub[1]["key"] == "k"
    # descriptors match the live listing shape
    node = only(filter(n -> n["key"] == "arr", PDVKernel.cached_tree_listing("data")))
    @test node["type"] == "ndarray" && node["parent_path"] == "data"

    # mutations refresh through the debounce flush (the timer's callback)
    tree["data.extra"] = 42
    PDVKernel._flush_changes(tree)  # flush directly; timer needs a live event loop
    # NOTE: _flush_changes only rebuilds when tree is the registered root —
    # simulate that wiring, then verify the rebuild really happened.
    if PDVKernel._ROOT_TREE[] === nothing
        PDVKernel._ROOT_TREE[] = tree
        tree.send_fn = (msg_type, payload) -> nothing  # flush needs a sink
        try
            tree["data.extra2"] = 43
            PDVKernel._flush_changes(tree)
            @test any(n -> n["key"] == "extra2", PDVKernel.cached_tree_listing("data"))
        finally
            PDVKernel._ROOT_TREE[] = nothing
            tree.send_fn = nothing
        end
    end

    # deleted paths drop out on rebuild
    delete!(tree, "config")
    PDVKernel.rebuild_query_cache!(tree)
    @test PDVKernel.cached_tree_listing("config") === nothing
    @test !any(n -> n["key"] == "config", PDVKernel.cached_tree_listing(""))

    # threaded-mode request handling is pure snapshot: list served, value
    # queries and cache misses bounce with query.kernel_busy
    reqjson(t, p) = Vector{UInt8}(codeunits(JSON.json(request(t, p))))
    resp = PDVKernel._handle_threaded_query(reqjson("pdv.tree.list", Dict{String,Any}("path" => "data")))
    @test resp["status"] == "ok"
    @test any(n -> n["key"] == "arr", resp["payload"]["nodes"])
    resp = PDVKernel._handle_threaded_query(reqjson("pdv.tree.list", Dict{String,Any}("path" => "nope")))
    @test resp["status"] == "error" && resp["payload"]["code"] == "query.kernel_busy"
    resp = PDVKernel._handle_threaded_query(reqjson("pdv.tree.get", Dict{String,Any}("path" => "data.arr")))
    @test resp["status"] == "error" && resp["payload"]["code"] == "query.kernel_busy"
    resp = PDVKernel._handle_threaded_query(reqjson("pdv.tree.delete", Dict{String,Any}("path" => "x")))
    @test resp["status"] == "error" && resp["payload"]["code"] == "query.not_allowed"
    resp = PDVKernel._handle_threaded_query(Vector{UInt8}(codeunits("{not json")))
    @test resp["status"] == "error"
    PDVKernel.clear_query_cache!()

    # Cycle guard (review): a self-referential Dict used to recurse to the
    # 50k node cap (or a StackOverflow) on EVERY rebuild, leaving the
    # snapshot permanently stale. The IdDict visited-set keeps the walk
    # total; deeper paths into the cycle just bounce to the comm channel.
    cyclic = Dict{String,Any}("val" => 1)
    cyclic["self"] = cyclic
    tree["loop"] = cyclic
    tree["after"] = "still listed"
    PDVKernel.rebuild_query_cache!(tree)
    root2 = PDVKernel.cached_tree_listing("")
    @test root2 !== nothing
    @test any(n -> n["key"] == "after", root2)     # walk completed past the cycle
    loop_nodes = PDVKernel.cached_tree_listing("loop")
    @test loop_nodes !== nothing
    @test sort([n["key"] for n in loop_nodes]) == ["self", "val"]
    # the revisited container keeps its FIRST listing; the cyclic re-entry
    # is simply absent from the snapshot (bounces live), not infinite
    @test PDVKernel.cached_tree_listing("loop.self") === nothing
    delete!(tree, "loop")
    PDVKernel.clear_query_cache!()
end

@testset "tree_loader: conflict strategies" begin
    wd = mktempdir()
    nodes = Any[
        Dict{String,Any}("path" => "f", "type" => "folder",
                         "storage" => Dict{String,Any}("backend" => "none", "format" => "none")),
        Dict{String,Any}("path" => "f.x", "type" => "scalar",
                         "storage" => Dict{String,Any}("backend" => "inline",
                                                       "format" => "inline", "value" => 7)),
    ]
    t = PDVTree()
    t.working_dir = wd
    skipped = load_tree_index(t, nodes; working_dir=wd)
    @test isempty(skipped)
    @test t["f.x"] == 7

    # skip strategy preserves existing values
    t["f.x"] = 99
    load_tree_index(t, nodes; working_dir=wd, conflict_strategy="skip")
    @test t["f.x"] == 99

    # unsafe uuid skipped and reported
    bad = Any[Dict{String,Any}("path" => "evil", "type" => "script",
                               "uuid" => "../escape",
                               "storage" => Dict{String,Any}(
                                   "backend" => "local_file", "uuid" => "../escape",
                                   "filename" => "x.jl", "format" => "jl_script"))]
    skipped = load_tree_index(t, bad; working_dir=wd)
    @test length(skipped) == 1
    @test occursin("unsafe UUID", skipped[1]["error"])
end

@testset "public API" begin
    # add_file / new_note need an active tree with a working dir
    wd = mktempdir()
    tree = PDVTree()
    tree.working_dir = wd
    with_active_tree(tree) do
        capture_messages() do
            src = joinpath(mktempdir(), "mesh.dat")
            write(src, "fake-mesh-bytes")
            node = PDVKernel.add_file(src)
            @test node isa PDVFile
            @test isfile(resolve_path(node, wd))
            @test read(resolve_path(node, wd), String) == "fake-mesh-bytes"
            @test_throws ArgumentError PDVKernel.add_file(joinpath(wd, "nope.h5"))

            # HDF5 extensions autodetect to the lazy node type (no open
            # at import — the fake bytes would fail an eager open).
            h5src = joinpath(mktempdir(), "mesh.h5")
            write(h5src, "fake-h5-bytes")
            h5node = PDVKernel.add_file(h5src)
            @test h5node isa PDVHdf5
            @test isfile(resolve_path(h5node, wd))
            @test h5node.handle === nothing

            PDVKernel.new_note("notes.intro"; title="Introduction")
            @test tree["notes.intro"] isa PDVNote
            @test tree["notes.intro"].title == "Introduction"
            note_file = resolve_path(tree["notes.intro"], wd)
            @test occursin("# Introduction", read(note_file, String))

            # save_project to an explicit path
            save_dir = mktempdir()
            PDVKernel.save_project(save_dir)
            @test isfile(joinpath(save_dir, "tree-index.json"))
        end
    end

    # version constants agree
    @test PDVKernel.VERSION == PDVKernel.__pdv_protocol_version__
    @test occursin(r"^\d+\.\d+\.\d+", PDVKernel.VERSION)
end

@testset "package verbs target the active environment" begin
    # Empty-arg calls print a notice and never touch Pkg.
    @test PDVKernel.install() === nothing
    @test PDVKernel.remove() === nothing

    # remove() edits the ACTIVE project environment (§10.6.8): seed a dummy
    # package into a temp project offline via Pkg.develop(path=...), then
    # PDVKernel.remove it and confirm Project.toml's [deps] lost the entry.
    dummy = mktempdir()
    dummy_uuid = string(uuid4())
    write(joinpath(dummy, "Project.toml"),
          "name = \"PDVDummyPkg\"\nuuid = \"$dummy_uuid\"\nversion = \"0.1.0\"\n")
    mkpath(joinpath(dummy, "src"))
    write(joinpath(dummy, "src", "PDVDummyPkg.jl"), "module PDVDummyPkg\nend\n")

    project_dir = mktempdir()
    old_project = Base.active_project()
    try
        Pkg.activate(project_dir; io=devnull)
        Pkg.develop(path=dummy; io=devnull)
        deps = get(TOML.parsefile(joinpath(project_dir, "Project.toml")), "deps", Dict())
        @test haskey(deps, "PDVDummyPkg")

        PDVKernel.remove("PDVDummyPkg")
        deps = get(TOML.parsefile(joinpath(project_dir, "Project.toml")), "deps", Dict())
        @test !haskey(deps, "PDVDummyPkg")
    finally
        Pkg.activate(old_project; io=devnull)
    end
end

@testset "install() accepts REPL-style Name@version pins" begin
    # Pkg.add(::String) rejects "Name@1.6"; install() translates it to a
    # PackageSpec so the Packages tab / cells can pin versions (§10.6.8).
    plain = PDVKernel._package_spec("DataFrames")
    @test plain.name == "DataFrames"

    pinned = PDVKernel._package_spec("DataFrames@1.6")
    @test pinned.name == "DataFrames"
    @test pinned.version == "1.6"

    # Only the first '@' splits — prerelease/build suffixes survive.
    pre = PDVKernel._package_spec("Example@0.5.5-rc1")
    @test pre.name == "Example"
    @test pre.version == "0.5.5-rc1"
end

@testset "threaded-region leak heal (posterror hook)" begin
    region_count() = ccall(:jl_in_threaded_region, Cint, ())

    # Nothing leaked → no-op.
    @test region_count() == 0
    @test PDVKernel.heal_threaded_region_leak!() == false

    # Manual escape hatch: releases one leaked increment, never underflows.
    ccall(:jl_enter_threaded_region, Cvoid, ())
    @test region_count() != 0
    @test (@test_logs (:warn, r"leaked threaded-region") PDVKernel.heal_threaded_region_leak!()) == true
    @test region_count() == 0
    # Asking for more than is leaked stops at zero (no underflow).
    ccall(:jl_enter_threaded_region, Cvoid, ())
    PDVKernel.heal_threaded_region_leak!(5)
    @test region_count() == 0

    # End-to-end: interrupt a real `@threads` loop mid-run. threading_run
    # has no try/finally, so the unwind leaks one increment; the posterror
    # heal (running inside the catch, like IJulia's posterror hooks) must
    # release exactly it.
    t = @task begin
        try
            Threads.@threads :static for i in 1:1
                sleep(3)
            end
        catch
            # Inside the catch, current_exceptions() carries the
            # InterruptException with threading_run in its backtrace —
            # exactly what the IJulia posterror hook sees.
            PDVKernel._posterror_thread_heal()
        end
    end
    schedule(t)
    sleep(0.3)                       # let it block inside threading_run's wait
    @test region_count() != 0        # loop is running: increment legitimately held
    schedule(t, InterruptException(); error=true)
    wait(t)
    @test region_count() == 0        # leak healed by the posterror path

    # `@threads :static` works again after the heal (this is the exact call
    # that errors with "cannot be used concurrently or nested" pre-heal).
    acc = zeros(Int, 4)
    Threads.@threads :static for i in 1:4
        acc[i] = i
    end
    @test acc == [1, 2, 3, 4]

    # M3 regression: a nonzero counter held by someone else's LIVE
    # threading_run must NOT be touched by an unrelated cell error — the
    # old blind per-cell decrement underflowed it on background-task exit.
    ccall(:jl_enter_threaded_region, Cvoid, ())   # simulate live background @threads
    try
        error("ordinary cell error")
    catch
        PDVKernel._posterror_thread_heal()        # posterror on a non-interrupt error
    end
    @test region_count() != 0        # untouched: nothing attributable leaked
    # An interrupt with no threading_run frame is also not a leak.
    try
        throw(InterruptException())
    catch
        PDVKernel._posterror_thread_heal()
    end
    @test region_count() != 0
    ccall(:jl_exit_threaded_region, Cvoid, ())    # background task exits cleanly
    @test region_count() == 0
end

# ---------------------------------------------------------------------------
# PDVHdf5 lazy data nodes (parity with pdv-python's PDVHdf5)
# ---------------------------------------------------------------------------

# Write a small nested HDF5 fixture: two root members, one nested group.
function _write_test_h5(path::String)
    ensure_parent(path)
    HDF5.h5open(path, "w") do f
        f["temp"] = collect(1.0:6.0)
        g = HDF5.create_group(f, "profiles")
        g["pressure"] = reshape(collect(1.0:6.0), 2, 3)
        g["cvec"] = ComplexF64[1.0 + 2.0im, 3.0 - 1.0im]
        sub = HDF5.create_group(g, "deep")
        sub["flag"] = Int32[1, 2]
    end
    return path
end

# Register a PDVHdf5 node backed by a fresh fixture under `wd`.
function _make_h5_node(wd::String; filename::String="data.h5")
    uuid = generate_node_uuid()
    _write_test_h5(uuid_tree_path(wd, uuid, filename))
    return PDVHdf5(uuid=uuid, filename=filename)
end

@testset "PDVHdf5: lazy struct + previews" begin
    wd = mktempdir()
    node = _make_h5_node(wd)

    # Construction is I/O-free; nothing opens until first access.
    @test node.handle === nothing
    @test node.open_error === nothing
    @test detect_kind(node) == "hdf5_file"
    @test occursin("PDVHdf5(uuid=", sprint(show, node))

    tree = PDVTree()
    tree.working_dir = wd
    tree["h5"] = node
    with_active_tree(tree) do
        @test PDVKernel.preview(node) == "data.h5 — 2 items"   # opens lazily
        @test node.handle !== nothing
        @test Set(keys(node)) == Set(["temp", "profiles"])
        # Slash paths resolve natively; dot-paths descend via the adapter.
        @test node["profiles/pressure"][:, :] == reshape(collect(1.0:6.0), 2, 3)
        @test_throws KeyError node["nope"]
        @test haskey(node, "profiles/deep")
        @test !haskey(node, "nope")

        # close is the retry path: handle + memo drop, next access reopens
        PDVKernel.close_hdf5!(node)
        @test node.handle === nothing
        @test node.listing_memo === nothing
        @test node["temp"][:] == collect(1.0:6.0)
    end

    # Dependency message names the installer (HDF5 is present in the test
    # env, so exercise the builder directly).
    @test occursin("PDVKernel.install(\"HDF5\")", PDVKernel._hdf5_dep_error_message())

    # haskey exception contract (review): a virtual child lookup that
    # throws means "absent" — EXCEPT interrupts, which must propagate
    # (Python's `except Exception` never caught KeyboardInterrupt).
    tv = PDVTree()
    tv["v"] = _ThrowingVirtual()
    @test !haskey(tv, "v.anything")
    @test_throws InterruptException haskey(tv, "v.interrupt")

    # deepcopy drops the live handle (same uuid — duplicate handles the
    # fresh-uuid relocation separately).
    with_active_tree(tree) do
        PDVKernel.open_hdf5!(node)
        clone = deepcopy(node)
        @test clone isa PDVHdf5
        @test clone.uuid == node.uuid
        @test clone.filename == node.filename
        @test clone.handle === nothing
        @test clone.open_error === nothing
    end
end

@testset "PDVHdf5: virtual children in tree.list / tree.get" begin
    wd = mktempdir()
    tree = PDVTree()
    tree.working_dir = wd
    tree["h5"] = _make_h5_node(wd)

    # Root listing: the node itself is expandable with a live preview.
    captured = run_handler(tree, "pdv.tree.list", Dict{String,Any}("path" => ""))
    root_nodes = response_of(captured, "pdv.tree.list")["payload"]["nodes"]
    h5_node = only(n for n in root_nodes if n["key"] == "h5")
    @test h5_node["type"] == "hdf5_file"
    @test h5_node["has_children"] == true
    @test h5_node["preview"] == "data.h5 — 2 items"
    @test !haskey(h5_node, "parent_is_opaque")     # parent is the real tree

    # Node listing: virtual children with runtime-only kinds, opaque parent.
    captured = run_handler(tree, "pdv.tree.list", Dict{String,Any}("path" => "h5"))
    nodes = response_of(captured, "pdv.tree.list")["payload"]["nodes"]
    byname = Dict(n["key"] => n for n in nodes)
    @test Set(keys(byname)) == Set(["temp", "profiles"])
    @test all(n["parent_is_opaque"] == true for n in nodes)
    @test byname["temp"]["type"] == "hdf5_dataset"
    @test byname["temp"]["preview"] == "float64 (6)"
    @test byname["temp"]["has_children"] == false
    @test byname["profiles"]["type"] == "hdf5_group"
    @test byname["profiles"]["preview"] == "group (3 items)"
    @test byname["profiles"]["has_children"] == true

    # Nested group listing through the foreign HDF5.Group adapter.
    captured = run_handler(tree, "pdv.tree.list", Dict{String,Any}("path" => "h5.profiles"))
    nodes = response_of(captured, "pdv.tree.list")["payload"]["nodes"]
    byname = Dict(n["key"] => n for n in nodes)
    @test Set(keys(byname)) == Set(["pressure", "cvec", "deep"])
    @test byname["pressure"]["preview"] == "float64 (2 × 3)"
    @test byname["cvec"]["preview"] == "complex128 (2)"
    @test byname["deep"]["type"] == "hdf5_group"
    captured = run_handler(tree, "pdv.tree.list",
                           Dict{String,Any}("path" => "h5.profiles.deep"))
    nodes = response_of(captured, "pdv.tree.list")["payload"]["nodes"]
    @test only(nodes)["key"] == "flag"
    @test only(nodes)["preview"] == "int32 (2)"

    # Dot-path descent to arbitrary depth (live values + tree.get).
    @test tree["h5.profiles.pressure"][:, :] == reshape(collect(1.0:6.0), 2, 3)
    @test haskey(tree, "h5.profiles.deep.flag")
    @test !haskey(tree, "h5.profiles.nope")
    @test_throws PDVKeyError tree["h5.nope"]
    captured = run_handler(tree, "pdv.tree.get",
                           Dict{String,Any}("path" => "h5.profiles.pressure"))
    resp = response_of(captured, "pdv.tree.get")
    @test resp["status"] == "ok"
    @test resp["payload"]["type"] == "hdf5_dataset"

    # A dataset is a leaf: not listable, and resolve_file works on the node.
    captured = run_handler(tree, "pdv.tree.list", Dict{String,Any}("path" => "h5.temp"))
    @test response_of(captured, "pdv.tree.list")["payload"]["code"] == "tree.not_a_folder"
    captured = run_handler(tree, "pdv.tree.resolve_file", Dict{String,Any}("path" => "h5"))
    resp = response_of(captured, "pdv.tree.resolve_file")
    @test resp["payload"]["file_path"] ==
          uuid_tree_path(wd, tree["h5"].uuid, "data.h5")

    # Unreadable file: parent listing degrades, direct listing reports
    # tree.load_error, and close_hdf5! clears the recorded error (retry).
    bad_uuid = generate_node_uuid()
    bad_path = uuid_tree_path(wd, bad_uuid, "bad.h5")
    ensure_parent(bad_path)
    write(bad_path, "this is not an HDF5 file")
    tree["bad"] = PDVHdf5(uuid=bad_uuid, filename="bad.h5")
    captured = run_handler(tree, "pdv.tree.list", Dict{String,Any}("path" => ""))
    root_nodes = response_of(captured, "pdv.tree.list")["payload"]["nodes"]
    bad_node = only(n for n in root_nodes if n["key"] == "bad")
    @test bad_node["preview"] == "bad.h5 (unreadable)"
    @test bad_node["has_children"] == false
    captured = run_handler(tree, "pdv.tree.list", Dict{String,Any}("path" => "bad"))
    resp = response_of(captured, "pdv.tree.list")
    @test resp["status"] == "error"
    @test resp["payload"]["code"] == "tree.load_error"
    @test occursin("Cannot open 'bad.h5'", resp["payload"]["message"])
    @test tree["bad"].open_error !== nothing
    # Fix the file and retry through close.
    _write_test_h5(bad_path)
    PDVKernel.close_hdf5!(tree["bad"])
    captured = run_handler(tree, "pdv.tree.list", Dict{String,Any}("path" => "bad"))
    @test response_of(captured, "pdv.tree.list")["status"] == "ok"
end

@testset "PDVHdf5: serialize / load / register / duplicate" begin
    wd = mktempdir()
    tree = PDVTree()
    tree.working_dir = wd
    node = _make_h5_node(wd)
    tree["h5"] = node

    # Serialize: copy-as-is with the shared kind/format strings and
    # preview-only metadata (no header caching in tree-index.json).
    descriptor = with_active_tree(tree) do
        serialize_node("h5", node, wd)
    end
    @test descriptor["type"] == "hdf5_file"
    @test descriptor["uuid"] == node.uuid
    @test descriptor["storage"]["format"] == "hdf5"
    @test descriptor["storage"]["backend"] == "local_file"
    @test descriptor["storage"]["filename"] == "data.h5"
    @test collect(keys(descriptor["metadata"])) == ["preview"]

    # Loader round trip: reconstructed lazily with zero I/O.
    tree2 = PDVTree()
    tree2.working_dir = wd
    skipped = load_tree_index(tree2, Any[descriptor]; working_dir=wd)
    @test isempty(skipped)
    reloaded = tree2["h5"]
    @test reloaded isa PDVHdf5
    @test reloaded.uuid == node.uuid
    @test reloaded.filename == "data.h5"
    @test reloaded.handle === nothing
    with_active_tree(tree2) do
        @test Set(keys(reloaded)) == Set(["temp", "profiles"])
    end

    # A Python-authored PDVDataset node skips gracefully with a pointer to
    # Python sessions (project still loads).
    nc_uuid = generate_node_uuid()
    nc_path = uuid_tree_path(wd, nc_uuid, "sim.nc")
    ensure_parent(nc_path)
    write(nc_path, "netcdf bytes")
    py_node = Dict{String,Any}(
        "path" => "sim", "type" => "dataset_file", "uuid" => nc_uuid,
        "storage" => Dict{String,Any}(
            "backend" => "local_file", "uuid" => nc_uuid,
            "filename" => "sim.nc", "format" => "netcdf"))
    skipped = load_tree_index(tree2, Any[py_node]; working_dir=wd)
    @test length(skipped) == 1
    @test occursin("Python", skipped[1]["error"])
    @test !haskey(tree2, "sim")

    # file.register: explicit node_type and extension autodetect.
    captured = run_handler(tree, "pdv.file.register", Dict{String,Any}(
        "tree_path" => "", "filename" => "run_data.h5",
        "node_type" => "hdf5_file", "uuid" => generate_node_uuid()))
    @test response_of(captured, "pdv.file.register")["status"] == "ok"
    @test tree["run_data"] isa PDVHdf5
    captured = run_handler(tree, "pdv.file.register", Dict{String,Any}(
        "tree_path" => "", "filename" => "auto.hdf5",
        "node_type" => "file", "uuid" => generate_node_uuid()))
    @test tree["auto"] isa PDVHdf5
    captured = run_handler(tree, "pdv.file.register", Dict{String,Any}(
        "tree_path" => "", "filename" => "plain.txt",
        "node_type" => "file", "uuid" => generate_node_uuid()))
    @test tree["plain"] isa PDVFile && !(tree["plain"] isa PDVHdf5)

    # add_hdf5 forces the node type regardless of extension.
    with_active_tree(tree) do
        capture_messages() do
            src = joinpath(mktempdir(), "renamed.dat")
            _write_test_h5(src)
            forced = PDVKernel.add_hdf5(src)
            @test forced isa PDVHdf5
            tree["forced"] = forced
            @test Set(keys(forced)) == Set(["temp", "profiles"])
        end
    end

    # Duplicate: fresh uuid, backing file copied, clone reads independently
    # (the cached handle must not survive into the clone).
    with_active_tree(tree) do
        @test Set(keys(node)) == Set(["temp", "profiles"])   # source handle open
        captured = run_handler(tree, "pdv.tree.duplicate",
                               Dict{String,Any}("path" => "h5", "new_path" => "h5copy"))
        @test response_of(captured, "pdv.tree.duplicate")["payload"]["duplicated"] == true
        clone = tree["h5copy"]
        @test clone isa PDVHdf5
        @test clone.uuid != node.uuid
        @test isfile(uuid_tree_path(wd, clone.uuid, "data.h5"))
        @test clone.handle === nothing
        @test Set(keys(clone)) == Set(["temp", "profiles"])
        @test node["temp"][:] == collect(1.0:6.0)            # source unaffected
    end
end

@testset "PDVHdf5: query-cache snapshot + memoization" begin
    wd = mktempdir()
    tree = PDVTree()
    tree.working_dir = wd
    node = _make_h5_node(wd)
    tree["h5"] = node
    tree["plain"] = Dict{String,Any}("k" => 1)

    with_active_tree(tree) do
        PDVKernel.clear_query_cache!()
        PDVKernel.rebuild_query_cache!(tree)

        # Virtual listings land in the snapshot at every depth.
        h5_listing = PDVKernel.cached_tree_listing("h5")
        @test h5_listing !== nothing
        @test Set(n["key"] for n in h5_listing) == Set(["temp", "profiles"])
        deep = PDVKernel.cached_tree_listing("h5.profiles.deep")
        @test deep !== nothing && only(deep)["key"] == "flag"

        # Threaded mode serves them read-only from the snapshot.
        reqjson(t, p) = Vector{UInt8}(codeunits(JSON.json(request(t, p))))
        resp = PDVKernel._handle_threaded_query(
            reqjson("pdv.tree.list", Dict{String,Any}("path" => "h5.profiles")))
        @test resp["status"] == "ok"
        @test any(n -> n["key"] == "pressure", resp["payload"]["nodes"])

        # Memoized per handle: a rebuild reuses the same listing vectors
        # instead of re-walking the (immutable) file.
        @test node.listing_memo !== nothing
        before = PDVKernel.cached_tree_listing("h5.profiles")
        PDVKernel.rebuild_query_cache!(tree)
        @test PDVKernel.cached_tree_listing("h5.profiles") === before
        # close invalidates the memo; the next rebuild re-reads.
        PDVKernel.close_hdf5!(node)
        @test node.listing_memo === nothing
        PDVKernel.rebuild_query_cache!(tree)
        after = PDVKernel.cached_tree_listing("h5.profiles")
        @test after !== nothing && after !== before

        # An unreadable node skips its own subtree, never the rebuild
        # (its has_children degrades to false, so the walk never descends).
        bad_uuid = generate_node_uuid()
        bad_path = uuid_tree_path(wd, bad_uuid, "bad.h5")
        ensure_parent(bad_path)
        write(bad_path, "garbage")
        tree["bad"] = PDVHdf5(uuid=bad_uuid, filename="bad.h5")
        PDVKernel.rebuild_query_cache!(tree)
        @test PDVKernel.cached_tree_listing("bad") === nothing
        @test PDVKernel.cached_tree_listing("plain") !== nothing
        @test PDVKernel.cached_tree_listing("h5") !== nothing

        PDVKernel.clear_query_cache!()
    end
end

@testset "PDVHdf5: default handlers (HDF5.Dataset + complex arrays)" begin
    clear_handlers!()
    wd = mktempdir()
    tree = PDVTree()
    tree.working_dir = wd
    node = _make_h5_node(wd)
    tree["h5"] = node

    with_active_tree(tree) do
        dset = tree["h5.temp"]
        @test has_handler_for(dset)                 # lazy HDF5 default registered

        # Without a Makie backend the handler materializes and prints the
        # plot notice — dispatched, never thrown.
        local result
        notice = mktemp() do tmppath, tmpio
            redirect_stdout(tmpio) do
                result = dispatch_handler(dset, "h5.temp", tree)
            end
            flush(tmpio)
            read(tmppath, String)
        end
        @test result["dispatched"] == true
        @test occursin("[PDV] Cannot plot 'h5.temp'", notice)

        # Complex 1-D through the same path (h5 read → complex pdv_handle).
        cdset = tree["h5.profiles.cvec"]
        local cresult
        cnotice = mktemp() do tmppath, tmpio
            redirect_stdout(tmpio) do
                cresult = dispatch_handler(cdset, "h5.profiles.cvec", tree)
            end
            flush(tmpio)
            read(tmppath, String)
        end
        @test cresult["dispatched"] == true
        @test occursin("[PDV] Cannot plot 'h5.profiles.cvec'", cnotice)

        # Non-numeric element types bail BEFORE any read — even with the
        # cap floored, a string dataset must hit the no-default-plot notice,
        # never the cap message (the sizeof-throws → nbytes=0 bypass would
        # have materialized it first; review finding).
        suuid = generate_node_uuid()
        spath_h5 = uuid_tree_path(wd, suuid, "strings.h5")
        ensure_parent(spath_h5)
        HDF5.h5open(spath_h5, "w") do f
            f["labels"] = ["alpha", "beta", "gamma"]
        end
        tree["strs"] = PDVHdf5(uuid=suuid, filename="strings.h5")
        old_cap0 = PDVKernel._HDF5_PLOT_MAX_BYTES[]
        PDVKernel._HDF5_PLOT_MAX_BYTES[] = 1
        try
            sdset = tree["strs.labels"]
            local sresult
            snotice = mktemp() do tmppath, tmpio
                redirect_stdout(tmpio) do
                    sresult = dispatch_handler(sdset, "strs.labels", tree)
                end
                flush(tmpio)
                read(tmppath, String)
            end
            @test sresult["dispatched"] == true
            @test occursin("No default plot", snotice)
            @test !occursin("default-plot cap", snotice)
        finally
            PDVKernel._HDF5_PLOT_MAX_BYTES[] = old_cap0
        end

        # Size cap: lower it and confirm the slice hint replaces the read.
        old_cap = PDVKernel._HDF5_PLOT_MAX_BYTES[]
        PDVKernel._HDF5_PLOT_MAX_BYTES[] = 16
        try
            local capped
            cap_notice = mktemp() do tmppath, tmpio
                redirect_stdout(tmpio) do
                    capped = dispatch_handler(dset, "h5.temp", tree)
                end
                flush(tmpio)
                read(tmppath, String)
            end
            @test capped["dispatched"] == true
            @test occursin("default-plot cap", cap_notice)
            @test occursin("slice", cap_notice)
        finally
            PDVKernel._HDF5_PLOT_MAX_BYTES[] = old_cap
        end
    end

    # Complex arrays have first-class defaults (Python complex parity).
    cvec = ComplexF64[1.0 + 2.0im, 3.0 - 1.0im]
    @test has_handler_for(cvec)
    @test has_handler_for(rand(ComplexF64, 2, 2))
    local c3result
    c3notice = mktemp() do tmppath, tmpio
        redirect_stdout(tmpio) do
            c3result = dispatch_handler(rand(ComplexF64, 2, 2, 2), "data.ccube", tree)
        end
        flush(tmpio)
        read(tmppath, String)
    end
    @test c3result["dispatched"] == true
    @test occursin("3-D complex array", c3notice)
    clear_handlers!()
end

@testset "tree version counter + post-execute fingerprint" begin
    # Mirrors pdv-python's TestTreeVersion / TestPostExecuteFingerprint.
    t = PDVTree()
    msgs = Tuple{String,Dict}[]
    attach_comm!(t, (ty, pl) -> push!(msgs, (ty, pl)))
    try
        # Every mutation notification bumps the counter.
        before = PDVKernel.get_tree_version()
        t["v1"] = 1
        t["v1"] = 2
        delete!(t, "v1")
        @test PDVKernel.get_tree_version() >= before + 3

        # pdv.tree.version handler responds with the counter.
        captured = run_handler(t, "pdv.tree.version")
        resp = response_of(captured, "pdv.tree.version")
        @test resp["status"] == "ok"
        @test resp["payload"]["version"] == PDVKernel.get_tree_version()

        # Whitelisted on the query server.
        @test "pdv.tree.version" in PDVKernel._QUERY_ALLOWED_TYPES

        # Post-execute fingerprint: baseline, then a silent plain-Dict
        # mutation bumps and pings; notified mutations stay quiet.
        PDVKernel._LAST_FINGERPRINT[] = nothing
        PDVKernel._CHANGED_SINCE_FINGERPRINT[] = false
        set_quiet!(t, "data", Dict{String,Any}("x" => 1))
        PDVKernel._post_execute_version_check()  # baseline; first check never pings

        vbefore = PDVKernel.get_tree_version()
        t.data["data"]["y"] = 2  # bypasses PDVTree setindex! — no notification
        PDVKernel._post_execute_version_check()
        @test PDVKernel.get_tree_version() == vbefore + 1
        # The coarse ping is debounced; flush it and check it arrived.
        PDVKernel._flush_global()
        @test any(m -> m[2]["change_type"] == "unknown", msgs)

        # A notified mutation records the new fingerprint without pinging.
        empty!(msgs)
        t["notified"] = 1
        _flush_changes(t)
        vafter = PDVKernel.get_tree_version()
        PDVKernel._post_execute_version_check()
        @test PDVKernel.get_tree_version() == vafter  # no extra bump
        PDVKernel._flush_global()
        @test !any(m -> m[2]["change_type"] == "unknown", msgs)

        # No drift → no bump, no ping.
        vquiet = PDVKernel.get_tree_version()
        PDVKernel._post_execute_version_check()
        @test PDVKernel.get_tree_version() == vquiet

        # Scalar leaf values participate (previews show them).
        t.data["data"]["x"] = 999
        PDVKernel._post_execute_version_check()
        @test PDVKernel.get_tree_version() == vquiet + 1
    finally
        detach_comm!(t)
    end
end

end # top-level testset
