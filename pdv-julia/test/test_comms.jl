using Test
using PDVKernel
using PDVKernel: check_version, PDVVersionError, PDV_PROTOCOL_VERSION

@testset "check_version" begin
    # Valid version
    msg = Dict{String,Any}("pdv_version" => "1.0")
    @test check_version(msg) === nothing  # Should not throw

    msg = Dict{String,Any}("pdv_version" => "1.5")
    @test check_version(msg) === nothing  # Same major version

    # Invalid version
    msg = Dict{String,Any}("pdv_version" => "2.0")
    @test_throws PDVVersionError check_version(msg)

    # Missing version
    msg = Dict{String,Any}()
    @test_throws PDVVersionError check_version(msg)

    # Empty version
    msg = Dict{String,Any}("pdv_version" => "")
    @test_throws PDVVersionError check_version(msg)
end

@testset "PDV_PROTOCOL_VERSION" begin
    @test PDV_PROTOCOL_VERSION == "1.0"
end
