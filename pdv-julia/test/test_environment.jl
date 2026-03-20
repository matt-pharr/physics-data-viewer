using Test
using PDVKernel
using PDVKernel: validate_working_dir, resolve_project_path, path_is_safe,
                 working_dir_tree_path, ensure_parent, make_working_dir,
                 PDVPathError

@testset "validate_working_dir" begin
    d = mktempdir()
    try
        result = validate_working_dir(d)
        @test isdir(result)
        @test isabspath(result)
    finally
        rm(d; recursive=true)
    end

    @test_throws PDVPathError validate_working_dir("/nonexistent/path/xyz")
end

@testset "make_working_dir" begin
    base = mktempdir()
    try
        wd = make_working_dir(base)
        @test isdir(wd)
        @test startswith(wd, base)
    finally
        rm(base; recursive=true)
    end

    @test_throws PDVPathError make_working_dir("/nonexistent/base/xyz")
end

@testset "resolve_project_path" begin
    root = mktempdir()
    try
        # Create a file to resolve
        mkpath(joinpath(root, "data"))
        touch(joinpath(root, "data", "file.txt"))

        result = resolve_project_path("data/file.txt", root)
        @test isabspath(result)
        @test isfile(result)

        # Absolute path rejected
        @test_throws PDVPathError resolve_project_path("/etc/passwd", root)
    finally
        rm(root; recursive=true)
    end
end

@testset "path_is_safe" begin
    root = mktempdir()
    try
        child = joinpath(root, "subdir")
        mkpath(child)

        @test path_is_safe(child, root)
        @test path_is_safe(root, root)
        @test !path_is_safe("/tmp", root)
    finally
        rm(root; recursive=true)
    end
end

@testset "working_dir_tree_path" begin
    result = working_dir_tree_path("/tmp/pdv-abc", "data.waveforms.ch1", ".jld2")
    expected = joinpath("/tmp/pdv-abc", "tree", "data", "waveforms", "ch1.jld2")
    @test result == expected
end

@testset "ensure_parent" begin
    d = mktempdir()
    try
        path = joinpath(d, "a", "b", "file.txt")
        result = ensure_parent(path)
        @test result == path
        @test isdir(joinpath(d, "a", "b"))
    finally
        rm(d; recursive=true)
    end
end
