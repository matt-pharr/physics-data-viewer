using Test
using PDVKernel
using PDVKernel: detect_kind, node_preview, julia_type_string, serialize_node,
                 deserialize_node, PDVTree, PDVScript, PDVNote, PDVGui,
                 PDVNamelist, PDVLib, PDVModule, PDVHDF5,
                 KIND_FOLDER, KIND_SCRIPT, KIND_MARKDOWN, KIND_GUI,
                 KIND_NAMELIST, KIND_LIB, KIND_HDF5, KIND_MODULE,
                 KIND_SCALAR, KIND_TEXT, KIND_MAPPING, KIND_SEQUENCE,
                 KIND_NDARRAY, KIND_BINARY, KIND_UNKNOWN

@testset "detect_kind" begin
    @test detect_kind(PDVTree()) == KIND_FOLDER
    @test detect_kind(PDVModule("id", "name", "1.0")) == KIND_MODULE
    @test detect_kind(42) == KIND_SCALAR
    @test detect_kind(3.14) == KIND_SCALAR
    @test detect_kind(true) == KIND_SCALAR
    @test detect_kind(nothing) == KIND_SCALAR
    @test detect_kind("hello") == KIND_TEXT
    @test detect_kind(Dict("a" => 1)) == KIND_MAPPING
    @test detect_kind([1, 2, 3]) == KIND_SEQUENCE
    @test detect_kind((1, 2)) == KIND_SEQUENCE
    @test detect_kind(UInt8[0x01, 0x02]) == KIND_BINARY
    @test detect_kind(rand(3, 4)) == KIND_NDARRAY
    # File types
    tmp = tempname() * ".jl"
    write(tmp, "function run(t) end")
    @test detect_kind(PDVScript(tmp)) == KIND_SCRIPT
    rm(tmp)
    @test detect_kind(PDVNote("note.md")) == KIND_MARKDOWN
    @test detect_kind(PDVGui("gui.json")) == KIND_GUI
    @test detect_kind(PDVNamelist("solver.nml")) == KIND_NAMELIST
    @test detect_kind(PDVLib("lib.jl")) == KIND_LIB
    @test detect_kind(PDVHDF5("data.h5")) == KIND_HDF5
end

@testset "node_preview" begin
    @test node_preview(42, KIND_SCALAR) == "42"
    @test node_preview(true, KIND_SCALAR) == "true"
    @test node_preview("hello", KIND_TEXT) == "hello"
    @test node_preview(Dict("a" => 1, "b" => 2), KIND_MAPPING) == "dict (2 keys)"
    @test node_preview([1, 2, 3], KIND_SEQUENCE) == "vector (3 items)"
    @test node_preview((1, 2), KIND_SEQUENCE) == "tuple (2 items)"
    @test node_preview(UInt8[0x01], KIND_BINARY) == "bytes (1 bytes)"
    @test node_preview(PDVTree(), KIND_FOLDER) == "folder"

    # Array preview
    arr = rand(3, 4)
    p = node_preview(arr, KIND_NDARRAY)
    @test occursin("3 × 4", p)
    @test occursin("Float64", p)

    # Long text truncation
    long_text = "x" ^ 100
    p = node_preview(long_text, KIND_TEXT)
    @test length(p) <= 54  # 50 + "..."
    @test endswith(p, "...")
end

@testset "julia_type_string" begin
    @test julia_type_string(42) == "Int64"
    @test julia_type_string("hello") == "String"
    @test julia_type_string([1, 2]) == "Vector{Int64}"
end

@testset "serialize and deserialize scalars" begin
    working_dir = mktempdir()
    try
        desc = serialize_node("x", 42, working_dir)
        @test desc["type"] == KIND_SCALAR
        @test desc["storage"]["backend"] == "inline"
        @test desc["storage"]["value"] == 42

        val = deserialize_node(desc["storage"], working_dir)
        @test val == 42
    finally
        rm(working_dir; recursive=true)
    end
end

@testset "serialize and deserialize text" begin
    working_dir = mktempdir()
    try
        # Short text (inline)
        desc = serialize_node("msg", "hello", working_dir)
        @test desc["storage"]["backend"] == "inline"
        @test desc["storage"]["value"] == "hello"

        val = deserialize_node(desc["storage"], working_dir)
        @test val == "hello"

        # Long text (file)
        long = "x" ^ 2000
        desc = serialize_node("long_msg", long, working_dir)
        @test desc["storage"]["backend"] == "local_file"
        @test desc["lazy"] == true

        val = deserialize_node(desc["storage"], working_dir)
        @test val == long
    finally
        rm(working_dir; recursive=true)
    end
end

@testset "serialize and deserialize mapping/sequence" begin
    working_dir = mktempdir()
    try
        d = Dict("a" => 1, "b" => [2, 3])
        desc = serialize_node("mydict", d, working_dir)
        @test desc["storage"]["backend"] == "inline"
        val = deserialize_node(desc["storage"], working_dir)
        @test val == d

        v = [1, 2, 3]
        desc = serialize_node("myvec", v, working_dir)
        @test desc["storage"]["backend"] == "inline"
        val = deserialize_node(desc["storage"], working_dir)
        @test val == v
    finally
        rm(working_dir; recursive=true)
    end
end

@testset "serialize binary" begin
    working_dir = mktempdir()
    try
        data = UInt8[0x01, 0x02, 0x03]
        desc = serialize_node("bindata", data, working_dir)
        @test desc["storage"]["backend"] == "local_file"
        @test desc["storage"]["format"] == "bin"

        val = deserialize_node(desc["storage"], working_dir)
        @test val == data
    finally
        rm(working_dir; recursive=true)
    end
end

@testset "serialize folder" begin
    working_dir = mktempdir()
    try
        desc = serialize_node("folder", PDVTree(), working_dir)
        @test desc["type"] == KIND_FOLDER
        @test desc["has_children"] == true
        @test desc["storage"]["backend"] == "none"
    finally
        rm(working_dir; recursive=true)
    end
end

@testset "serialize module" begin
    working_dir = mktempdir()
    try
        mod = PDVModule("test_mod", "Test Module", "1.0.0")
        desc = serialize_node("mymod", mod, working_dir)
        @test desc["type"] == KIND_MODULE
        @test desc["has_children"] == true
        @test desc["metadata"]["module_id"] == "test_mod"
    finally
        rm(working_dir; recursive=true)
    end
end

@testset "serialize script" begin
    working_dir = mktempdir()
    try
        script_path = joinpath(working_dir, "test_script.jl")
        write(script_path, "function run(t) end")
        script = PDVScript(script_path; language="julia")
        desc = serialize_node("scripts.test", script, working_dir;
                              source_dir=working_dir)
        @test desc["type"] == KIND_SCRIPT
        @test desc["storage"]["backend"] == "local_file"
        @test desc["metadata"]["language"] == "julia"
    finally
        rm(working_dir; recursive=true)
    end
end

@testset "serialize unknown type rejected without trusted" begin
    working_dir = mktempdir()
    try
        struct MyCustomType
            x::Int
        end
        @test_throws PDVKernel.PDVSerializationError serialize_node(
            "custom", MyCustomType(1), working_dir; trusted=false)
    finally
        rm(working_dir; recursive=true)
    end
end
