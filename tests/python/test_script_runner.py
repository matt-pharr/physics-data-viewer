"""
Test suite for PDVTree script runner functionality.

These tests verify that scripts can be created, loaded, and executed
correctly from the tree directory structure.
"""

import os
import sys
import tempfile
import shutil
import pytest
from pathlib import Path


class TestScriptRunner:
    """Test the PDVTree script runner with real script execution."""

    @pytest.fixture
    def temp_project_dir(self):
        """Create a temporary project directory for testing."""
        temp_dir = tempfile.mkdtemp(prefix='pdv_test_')
        yield temp_dir
        # Cleanup
        if os.path.exists(temp_dir):
            shutil.rmtree(temp_dir)

    @pytest.fixture
    def pdv_tree(self, temp_project_dir):
        """Initialize a PDVTree instance with test project root."""
        # Add the init directory to Python path to import python-init
        init_dir = Path(__file__).parent.parent.parent / 'electron' / 'main' / 'init'
        sys.path.insert(0, str(init_dir))
        
        # Import and initialize PDVTree
        import importlib.util
        spec = importlib.util.spec_from_file_location("python_init", init_dir / "python-init.py")
        python_init = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(python_init)
        
        # Create a new PDVTree instance
        tree = python_init.PDVTree()
        tree._set_project_root(temp_project_dir)
        
        # Create the tree structure
        tree_dir = os.path.join(temp_project_dir, 'tree')
        os.makedirs(os.path.join(tree_dir, 'data'), exist_ok=True)
        os.makedirs(os.path.join(tree_dir, 'scripts'), exist_ok=True)
        os.makedirs(os.path.join(tree_dir, 'results'), exist_ok=True)
        
        # Initialize tree subdirectories
        tree['data'] = python_init.PDVTree()
        tree['scripts'] = python_init.PDVTree()
        tree['results'] = python_init.PDVTree()
        
        yield tree

    def test_create_and_run_simple_script(self, pdv_tree, temp_project_dir):
        """Test creating and running a simple script."""
        # Create a test script
        scripts_dir = os.path.join(temp_project_dir, 'tree', 'scripts')
        script_path = os.path.join(scripts_dir, 'test_simple.py')
        
        script_content = '''"""Simple test script"""

def run(tree, **kwargs):
    return {"status": "success", "message": "Hello from script!"}
'''
        
        with open(script_path, 'w') as f:
            f.write(script_content)
        
        # Run the script
        result = pdv_tree.run_script('scripts.test_simple')
        
        # Verify result
        assert result is not None
        assert result['status'] == 'success'
        assert result['message'] == 'Hello from script!'

    def test_run_script_with_parameters(self, pdv_tree, temp_project_dir):
        """Test running a script with keyword parameters."""
        # Create a test script
        scripts_dir = os.path.join(temp_project_dir, 'tree', 'scripts')
        script_path = os.path.join(scripts_dir, 'test_params.py')
        
        script_content = '''"""Test script with parameters"""

def run(tree, **kwargs):
    return {
        "status": "success",
        "params": kwargs,
        "param1": kwargs.get("param1"),
        "param2": kwargs.get("param2")
    }
'''
        
        with open(script_path, 'w') as f:
            f.write(script_content)
        
        # Run the script with parameters
        result = pdv_tree.run_script('scripts.test_params', param1="value1", param2=42)
        
        # Verify result
        assert result is not None
        assert result['status'] == 'success'
        assert result['param1'] == 'value1'
        assert result['param2'] == 42
        assert result['params'] == {'param1': 'value1', 'param2': 42}

    def test_run_nested_script(self, pdv_tree, temp_project_dir):
        """Test running a script in a nested directory."""
        # Create nested directory
        nested_dir = os.path.join(temp_project_dir, 'tree', 'scripts', 'analysis')
        os.makedirs(nested_dir, exist_ok=True)
        
        # Create a test script in nested directory
        script_path = os.path.join(nested_dir, 'nested_test.py')
        
        script_content = '''"""Nested test script"""

def run(tree, **kwargs):
    return {"status": "success", "location": "nested"}
'''
        
        with open(script_path, 'w') as f:
            f.write(script_content)
        
        # Run the nested script
        result = pdv_tree.run_script('scripts.analysis.nested_test')
        
        # Verify result
        assert result is not None
        assert result['status'] == 'success'
        assert result['location'] == 'nested'

    def test_script_not_found_error(self, pdv_tree):
        """Test that running a non-existent script raises FileNotFoundError."""
        with pytest.raises(FileNotFoundError) as exc_info:
            pdv_tree.run_script('scripts.nonexistent')
        
        assert 'Script not found' in str(exc_info.value)

    def test_script_access_tree(self, pdv_tree, temp_project_dir):
        """Test that a script can access the tree object."""
        # Add some data to the tree
        pdv_tree['data']['test_value'] = 123
        
        # Create a test script that accesses tree
        scripts_dir = os.path.join(temp_project_dir, 'tree', 'scripts')
        script_path = os.path.join(scripts_dir, 'test_tree_access.py')
        
        script_content = '''"""Test script that accesses tree"""

def run(tree, **kwargs):
    return {
        "status": "success",
        "tree_data": tree.get('data', {}).get('test_value')
    }
'''
        
        with open(script_path, 'w') as f:
            f.write(script_content)
        
        # Run the script
        result = pdv_tree.run_script('scripts.test_tree_access')
        
        # Verify result
        assert result is not None
        assert result['status'] == 'success'
        assert result['tree_data'] == 123


if __name__ == '__main__':
    # Allow running tests directly with: python test_script_runner.py
    pytest.main([__file__, '-v'])
