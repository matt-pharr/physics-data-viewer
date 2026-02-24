# Julia Backend Tests

This directory contains tests for the Julia backend components of the Physics Data Viewer (future implementation).

## Status

⚠️ **NOT YET IMPLEMENTED** - This is scaffolding for future Julia backend tests.

## Planned Structure

When implemented, this directory will contain:

- `test_script_runner.jl` - Tests for Julia script creation and execution
- `runtests.jl` - Julia test runner configuration
- Test utilities and fixtures

## Future Setup

```bash
# Install Julia test dependencies (when implemented)
julia --project=. -e 'using Pkg; Pkg.add("Test")'
```

## Future Running Tests

```bash
# Run all Julia tests (when implemented)
cd tests/julia
julia runtests.jl
```

## Implementation Notes

The Julia backend will mirror the Python backend structure:
- PDVTree-like structure in Julia
- Script runner with `run(tree, kwargs...)` interface
- Integration with Jupyter Julia kernel
- Similar test patterns to Python tests
