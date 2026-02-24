# Python Backend Tests

This directory contains tests for the Python backend components of the Physics Data Viewer, including the PDVTree and script runner functionality.

## Setup

Install test dependencies:

```bash
pip install -r requirements.txt
```

## Running Tests

Run all Python tests:

```bash
cd tests/python
pytest -v
```

Run with coverage:

```bash
pytest --cov=../../electron/main/init --cov-report=html -v
```

Run a specific test file:

```bash
pytest test_script_runner.py -v
```

Run a specific test:

```bash
pytest test_script_runner.py::TestScriptRunner::test_create_and_run_simple_script -v
```

## Test Structure

- `test_script_runner.py` - Tests for PDVTree script creation and execution
- `conftest.py` - Pytest configuration and shared fixtures

## Writing New Tests

1. Create a new test file starting with `test_`
2. Import necessary modules and fixtures from `conftest.py`
3. Use pytest fixtures for setup and teardown
4. Follow the existing test patterns for consistency

Example:

```python
def test_my_feature(pdv_tree, temp_project_dir):
    # Arrange
    # ... setup code ...
    
    # Act
    result = pdv_tree.some_method()
    
    # Assert
    assert result == expected_value
```
