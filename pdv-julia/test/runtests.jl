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
                 pdv_namespace, inspect_namespace, load_lib_file!,
                 clear_lib_modules!, AutosaveCache, KIND_NDARRAY, KIND_SEQUENCE,
                 KIND_SCALAR, KIND_TEXT, KIND_MAPPING, KIND_BINARY, KIND_UNKNOWN
import JSON
import ZMQ
import Serialization
import Pkg
import TOML
using UUIDs: uuid4
using DataFrames

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

# A value Serialization refuses outright, for exercising the save walker's
# skip-and-report path. (A sleeping Task, surprisingly, serializes fine.)
struct _Unserializable end
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

    # Doc extraction: docstring, block comment (Description preferred),
    # line comment, bare code.
    doc_path = joinpath(wd, "docprobe.jl")
    write(doc_path, "\"\"\"Fit a line to the data.\"\"\"\nfunction run(pdv_tree) end")
    @test PDVKernel.extract_script_doc(doc_path) == "Fit a line to the data."
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
    @test isfile(joinpath(save_dir2, "tree-index.json"))
    index = JSON.parsefile(joinpath(save_dir2, "tree-index.json"))
    @test !any(n -> n["path"] == "poison", index)          # skipped, not written
    @test any(n -> n["path"] == "notes_text", index)       # the rest saved fine
    delete!(tree, "poison")
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
            src = joinpath(mktempdir(), "mesh.h5")
            write(src, "fake-mesh-bytes")
            node = PDVKernel.add_file(src)
            @test node isa PDVFile
            @test isfile(resolve_path(node, wd))
            @test read(resolve_path(node, wd), String) == "fake-mesh-bytes"
            @test_throws ArgumentError PDVKernel.add_file(joinpath(wd, "nope.h5"))

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

end # top-level testset
