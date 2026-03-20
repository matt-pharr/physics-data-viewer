using Test
using PDVKernel
using PDVKernel: PDVTree, PDVScript, PDVNote, PDVGui, PDVNamelist, PDVModule,
                 set_working_dir!, attach_comm!, set_save_dir!, send_message,
                 send_error, get_pdv_tree, dispatch, handle_init,
                 handle_tree_list, handle_tree_get, handle_script_register,
                 handle_note_register, handle_gui_register,
                 handle_module_register, module_id

# Mock comm infrastructure
mutable struct MockComm
    sent::Vector{Dict{String,Any}}
end
MockComm() = MockComm(Dict{String,Any}[])

function setup_mock_comm()
    tree = PDVTree()
    wd = mktempdir()
    set_working_dir!(tree, wd)
    PDVKernel._pdv_tree[] = tree

    mock = MockComm()
    PDVKernel._comm[] = mock

    # Patch _send_comm_data to capture messages
    return tree, mock, wd
end

# Override _send_comm_data for testing
function PDVKernel._send_comm_data(data::Dict)
    comm = PDVKernel._comm[]
    if comm isa MockComm
        push!(comm.sent, data)
    end
end

function last_response(mock::MockComm)
    return isempty(mock.sent) ? nothing : mock.sent[end]
end

@testset "handle_init" begin
    tree, mock, wd = setup_mock_comm()
    try
        msg = Dict{String,Any}(
            "msg_id" => "test-1",
            "payload" => Dict{String,Any}("working_dir" => wd),
        )
        handle_init(msg)
        resp = last_response(mock)
        @test resp["type"] == "pdv.init.response"
        @test resp["status"] == "ok"
    finally
        rm(wd; recursive=true)
    end
end

@testset "handle_init missing working_dir" begin
    tree, mock, wd = setup_mock_comm()
    try
        msg = Dict{String,Any}("msg_id" => "test-2", "payload" => Dict{String,Any}())
        handle_init(msg)
        resp = last_response(mock)
        @test resp["status"] == "error"
        @test resp["payload"]["code"] == "init.missing_working_dir"
    finally
        rm(wd; recursive=true)
    end
end

@testset "handle_tree_list empty tree" begin
    tree, mock, wd = setup_mock_comm()
    try
        msg = Dict{String,Any}(
            "msg_id" => "test-3",
            "payload" => Dict{String,Any}("path" => ""),
        )
        handle_tree_list(msg)
        resp = last_response(mock)
        @test resp["type"] == "pdv.tree.list.response"
        @test resp["payload"]["nodes"] == []
    finally
        rm(wd; recursive=true)
    end
end

@testset "handle_tree_list with data" begin
    tree, mock, wd = setup_mock_comm()
    try
        tree["x"] = 42
        tree["name"] = "hello"

        msg = Dict{String,Any}(
            "msg_id" => "test-4",
            "payload" => Dict{String,Any}("path" => ""),
        )
        handle_tree_list(msg)
        resp = last_response(mock)
        nodes = resp["payload"]["nodes"]
        @test length(nodes) == 2
        paths = [n["path"] for n in nodes]
        @test "x" in paths
        @test "name" in paths
    finally
        rm(wd; recursive=true)
    end
end

@testset "handle_tree_get" begin
    tree, mock, wd = setup_mock_comm()
    try
        tree["x"] = 42

        msg = Dict{String,Any}(
            "msg_id" => "test-5",
            "payload" => Dict{String,Any}("path" => "x", "mode" => "value"),
        )
        handle_tree_get(msg)
        resp = last_response(mock)
        @test resp["status"] == "ok"
        @test resp["payload"]["type"] == "scalar"
    finally
        rm(wd; recursive=true)
    end
end

@testset "handle_tree_get path not found" begin
    tree, mock, wd = setup_mock_comm()
    try
        msg = Dict{String,Any}(
            "msg_id" => "test-6",
            "payload" => Dict{String,Any}("path" => "nonexistent"),
        )
        handle_tree_get(msg)
        resp = last_response(mock)
        @test resp["status"] == "error"
        @test resp["payload"]["code"] == "tree.path_not_found"
    finally
        rm(wd; recursive=true)
    end
end

@testset "handle_script_register" begin
    tree, mock, wd = setup_mock_comm()
    try
        msg = Dict{String,Any}(
            "msg_id" => "test-7",
            "payload" => Dict{String,Any}(
                "parent_path" => "scripts",
                "name" => "analysis",
                "relative_path" => "tree/scripts/analysis.jl",
                "language" => "julia",
            ),
        )
        handle_script_register(msg)
        resp = last_response(mock)
        @test resp["status"] == "ok"
        @test resp["payload"]["path"] == "scripts.analysis"
        @test haskey(tree, "scripts.analysis")
        @test tree["scripts.analysis"] isa PDVScript
    finally
        rm(wd; recursive=true)
    end
end

@testset "handle_note_register" begin
    tree, mock, wd = setup_mock_comm()
    try
        msg = Dict{String,Any}(
            "msg_id" => "test-8",
            "payload" => Dict{String,Any}(
                "parent_path" => "notes",
                "name" => "intro",
                "relative_path" => "tree/notes/intro.md",
            ),
        )
        handle_note_register(msg)
        resp = last_response(mock)
        @test resp["status"] == "ok"
        @test tree["notes.intro"] isa PDVNote
    finally
        rm(wd; recursive=true)
    end
end

@testset "handle_gui_register" begin
    tree, mock, wd = setup_mock_comm()
    try
        # First create a module
        tree["my_mod"] = PDVModule("my_mod", "My Module", "1.0")

        msg = Dict{String,Any}(
            "msg_id" => "test-9",
            "payload" => Dict{String,Any}(
                "parent_path" => "my_mod",
                "name" => "gui",
                "relative_path" => "tree/my_mod/gui.gui.json",
                "module_id" => "my_mod",
            ),
        )
        handle_gui_register(msg)
        resp = last_response(mock)
        @test resp["status"] == "ok"
        @test tree["my_mod.gui"] isa PDVGui
    finally
        rm(wd; recursive=true)
    end
end

@testset "handle_module_register" begin
    tree, mock, wd = setup_mock_comm()
    try
        msg = Dict{String,Any}(
            "msg_id" => "test-10",
            "payload" => Dict{String,Any}(
                "path" => "n_pendulum",
                "module_id" => "n_pendulum",
                "name" => "N-Pendulum",
                "version" => "2.0.0",
            ),
        )
        handle_module_register(msg)
        resp = last_response(mock)
        @test resp["status"] == "ok"
        @test tree["n_pendulum"] isa PDVModule
        @test module_id(tree["n_pendulum"]) == "n_pendulum"
    finally
        rm(wd; recursive=true)
    end
end

@testset "dispatch unknown message type" begin
    tree, mock, wd = setup_mock_comm()
    try
        msg = Dict{String,Any}(
            "type" => "pdv.nonexistent",
            "msg_id" => "test-11",
            "payload" => Dict{String,Any}(),
        )
        dispatch(msg)
        resp = last_response(mock)
        @test resp["status"] == "error"
        @test resp["payload"]["code"] == "protocol.unknown_type"
    finally
        rm(wd; recursive=true)
    end
end
