using Test
using PDVKernel
using PDVKernel: PDVTree, PDVScript, PDVNote, PDVGui, PDVNamelist, PDVLib,
                 PDVModule, PDVHDF5, PDVKeyError, PDVPathError,
                 split_dot_path, LazyLoadRegistry, ScriptParameter,
                 set_working_dir!, attach_comm!, emit_changed!,
                 has_lazy_entry, module_id, module_name, module_version,
                 children_tree, set_gui!, module_gui, relative_path,
                 language, doc, params, title, namelist_format, hdf5_path,
                 script_param_to_dict

@testset "split_dot_path" begin
    @test split_dot_path("a") == ["a"]
    @test split_dot_path("a.b.c") == ["a", "b", "c"]
    @test_throws PDVPathError split_dot_path("a..b")
    @test_throws PDVPathError split_dot_path(".a")
    @test_throws PDVPathError split_dot_path("a.")
end

@testset "PDVTree basic operations" begin
    tree = PDVTree()

    # Set and get single key
    tree["x"] = 42
    @test tree["x"] == 42
    @test haskey(tree, "x")

    # Set and get dot path
    tree["data.waveforms.ch1"] = [1.0, 2.0, 3.0]
    @test tree["data.waveforms.ch1"] == [1.0, 2.0, 3.0]
    @test haskey(tree, "data.waveforms.ch1")
    @test haskey(tree, "data")
    @test haskey(tree, "data.waveforms")

    # Delete
    delete!(tree, "x")
    @test !haskey(tree, "x")
    @test_throws PDVKeyError tree["x"]
    @test_throws PDVKeyError delete!(tree, "nonexistent")

    # Delete nested
    tree["a.b.c"] = 1
    delete!(tree, "a.b.c")
    @test !haskey(tree, "a.b.c")

    # Overwrite creates "updated"
    tree["foo"] = 1
    tree["foo"] = 2
    @test tree["foo"] == 2
end

@testset "PDVTree change notifications" begin
    tree = PDVTree()
    messages = []
    attach_comm!(tree, (type, payload) -> push!(messages, (type, payload)))

    tree["x"] = 1
    @test length(messages) == 1
    @test messages[1][1] == "pdv.tree.changed"
    @test messages[1][2]["change_type"] == "added"

    tree["x"] = 2
    @test length(messages) == 2
    @test messages[2][2]["change_type"] == "updated"

    delete!(tree, "x")
    @test length(messages) == 3
    @test messages[3][2]["change_type"] == "removed"
end

@testset "PDVTree iteration and keys" begin
    tree = PDVTree()
    tree["a"] = 1
    tree["b"] = 2
    tree["c"] = 3

    @test length(tree) == 3
    ks = collect(keys(tree))
    @test "a" in ks
    @test "b" in ks
    @test "c" in ks
end

@testset "PDVTree intermediate auto-creation" begin
    tree = PDVTree()
    tree["a.b.c"] = 42

    a = tree["a"]
    @test a isa PDVTree
    ab = tree["a.b"]
    @test ab isa PDVTree
    @test tree["a.b.c"] == 42
end

@testset "LazyLoadRegistry" begin
    reg = LazyLoadRegistry()

    storage = Dict{String,Any}(
        "backend" => "local_file",
        "relative_path" => "tree/data.txt",
        "format" => "txt",
    )
    PDVKernel.register!(reg, "data", storage)
    @test PDVKernel.has_entry(reg, "data")
    @test PDVKernel.get_storage(reg, "data") == storage

    PDVKernel.remove_entry!(reg, "data")
    @test !PDVKernel.has_entry(reg, "data")

    PDVKernel.clear_registry!(reg)
    @test isempty(PDVKernel.entries(reg))
end

@testset "PDVScript" begin
    # Create a temporary script file
    tmp = tempname() * ".jl"
    write(tmp, """
    function run(pdv_tree::AbstractDict; x::Int=1, y::Float64=2.0)
        return x + y
    end
    """)

    script = PDVScript(tmp; language="julia")
    @test relative_path(script) == tmp
    @test language(script) == "julia"

    # Parameter extraction
    p = params(script)
    @test length(p) == 2
    @test p[1].name == "x"
    @test p[1].type == "Int"
    @test p[1].default == 1
    @test !p[1].required
    @test p[2].name == "y"

    # Run
    tree = PDVTree()
    result = run_script(script, tree; x=10, y=3.0)
    @test result == 13.0

    rm(tmp)
end

@testset "PDVScript param dict conversion" begin
    p = ScriptParameter("x", "Int", 5, false)
    d = script_param_to_dict(p)
    @test d["name"] == "x"
    @test d["type"] == "Int"
    @test d["default"] == 5
    @test d["required"] == false
end

@testset "PDVNote" begin
    tmp = tempname() * ".md"
    write(tmp, "# My Note\nSome content here.")

    note = PDVNote(tmp; title="My Note")
    @test relative_path(note) == tmp
    @test title(note) == "My Note"
    @test PDVKernel.file_preview(note) == "My Note"

    # Without title, reads from file
    note2 = PDVNote(tmp)
    preview = PDVKernel.file_preview(note2)
    @test preview == "My Note"

    rm(tmp)
end

@testset "PDVGui" begin
    gui = PDVGui("path/to/gui.json"; module_id="my_mod")
    @test relative_path(gui) == "path/to/gui.json"
    @test module_id(gui) == "my_mod"
    @test PDVKernel.file_preview(gui) == "GUI"
end

@testset "PDVNamelist" begin
    nml = PDVNamelist("solver.nml"; format="fortran", module_id="mod1")
    @test relative_path(nml) == "solver.nml"
    @test namelist_format(nml) == "fortran"
    @test module_id(nml) == "mod1"
    @test PDVKernel.file_preview(nml) == "Namelist (fortran)"
end

@testset "PDVLib" begin
    lib = PDVLib("lib/mylib.jl"; module_id="mod1")
    @test relative_path(lib) == "lib/mylib.jl"
    @test module_id(lib) == "mod1"
    @test PDVKernel.file_preview(lib) == "Library (mylib.jl)"
end

@testset "PDVHDF5" begin
    h = PDVHDF5("data.h5"; hdf5_path="/group1")
    @test relative_path(h) == "data.h5"
    @test hdf5_path(h) == "/group1"
    @test PDVKernel.file_preview(h) == "HDF5"
end

@testset "PDVModule" begin
    mod = PDVModule("n_pendulum", "N-Pendulum", "2.0.0")
    @test module_id(mod) == "n_pendulum"
    @test module_name(mod) == "N-Pendulum"
    @test module_version(mod) == "2.0.0"
    @test module_gui(mod) === nothing

    # Children
    mod["scripts"] = PDVTree()
    @test haskey(mod, "scripts")
    @test length(mod) == 1

    # GUI
    gui = PDVGui("gui.json")
    set_gui!(mod, gui)
    @test module_gui(mod) === gui
end
