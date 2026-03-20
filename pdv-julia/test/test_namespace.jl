using Test
using PDVKernel
using PDVKernel: PDVApp, pdv_save, pdv_help, pdv_namespace, detect_kind

@testset "PDVApp" begin
    app = PDVApp()
    @test repr(app) == "<PDV app object — type pdv.help() for usage>"
end

@testset "pdv_namespace basic" begin
    # Create a test module with some variables
    mod = Module(:TestNS)
    Core.eval(mod, :(x = 42))
    Core.eval(mod, :(name = "hello"))
    Core.eval(mod, :(pdv_tree = "should be excluded"))
    Core.eval(mod, :(pdv = "should be excluded"))
    Core.eval(mod, :(_private = "hidden"))

    result = pdv_namespace(mod)

    @test haskey(result, "x")
    @test haskey(result, "name")
    @test !haskey(result, "pdv_tree")
    @test !haskey(result, "pdv")
    @test !haskey(result, "_private")

    @test result["x"]["type"] == "scalar"
    @test result["name"]["type"] == "text"
end

@testset "pdv_namespace with include_private" begin
    mod = Module(:TestNS2)
    Core.eval(mod, :(x = 42))
    Core.eval(mod, :(_secret = "hidden"))

    result = pdv_namespace(mod; include_private=true)
    @test haskey(result, "_secret")
end
