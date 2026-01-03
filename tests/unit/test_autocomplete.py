"""Unit tests for autocomplete functionality."""

import pytest

from platform.server.autocomplete import AutocompleteProvider


class TestAutocompleteProvider:
    """Tests for the AutocompleteProvider class."""

    def test_initialization(self):
        """Test that provider initializes correctly."""
        provider = AutocompleteProvider()
        assert provider is not None
        assert len(provider._python_keywords) > 0
        assert len(provider._python_builtins) > 0

    def test_empty_word_returns_no_completions(self):
        """Test that empty word returns no completions."""
        provider = AutocompleteProvider()
        completions = provider.get_completions("", cursor_position=0)
        assert completions == []

    def test_python_keyword_completion(self):
        """Test completion of Python keywords."""
        provider = AutocompleteProvider()
        completions = provider.get_completions("imp", cursor_position=3)
        assert "import" in completions

    def test_python_keyword_partial(self):
        """Test partial keyword completion."""
        provider = AutocompleteProvider()
        completions = provider.get_completions("de", cursor_position=2)
        assert "def" in completions
        assert "del" in completions

    def test_python_builtin_completion(self):
        """Test completion of Python builtins."""
        provider = AutocompleteProvider()
        completions = provider.get_completions("pri", cursor_position=3)
        assert "print" in completions

    def test_state_variable_completion(self):
        """Test completion of variables from state."""
        provider = AutocompleteProvider()
        state = {"my_var": 123, "my_value": "test", "other": 456}
        completions = provider.get_completions("my_", cursor_position=3, state=state)
        assert "my_var" in completions
        assert "my_value" in completions
        assert "other" not in completions

    def test_completion_sorting(self):
        """Test that completions are sorted alphabetically."""
        provider = AutocompleteProvider()
        state = {"zebra": 1, "apple": 2, "banana": 3}
        completions = provider.get_completions("", cursor_position=0, state=state)
        # Empty word returns empty list, so test with a common prefix
        state = {"a_zebra": 1, "a_apple": 2, "a_banana": 3}
        completions = provider.get_completions("a_", cursor_position=2, state=state)
        if len(completions) >= 2:
            assert completions == sorted(completions)

    def test_cursor_position_default(self):
        """Test that cursor position defaults to end of code."""
        provider = AutocompleteProvider()
        completions_explicit = provider.get_completions("imp", cursor_position=3)
        completions_default = provider.get_completions("imp")
        assert completions_explicit == completions_default

    def test_find_word_start_simple(self):
        """Test word start detection for simple cases."""
        provider = AutocompleteProvider()
        assert provider._find_word_start("import", 6) == 0
        assert provider._find_word_start("x = import", 10) == 4
        assert provider._find_word_start("x = my_var", 10) == 4

    def test_find_word_start_special_chars(self):
        """Test word start detection with special characters."""
        provider = AutocompleteProvider()
        assert provider._find_word_start("x + import", 10) == 4
        assert provider._find_word_start("func(import", 11) == 5

    def test_import_context_detection(self):
        """Test detection of import statement context."""
        provider = AutocompleteProvider()
        assert provider._is_import_context("import ", 7) is True
        assert provider._is_import_context("from ", 5) is True
        assert provider._is_import_context("import numpy", 12) is True
        assert provider._is_import_context("x = 5", 5) is False
        assert provider._is_import_context("print('import')", 15) is False

    def test_common_modules_in_import_context(self):
        """Test that common modules appear in import context."""
        provider = AutocompleteProvider()
        completions = provider.get_completions("import num", cursor_position=10)
        assert "numpy" in completions

    def test_common_modules_completion(self):
        """Test completion of common module names."""
        provider = AutocompleteProvider()
        modules = provider._get_common_modules()
        assert "numpy" in modules
        assert "scipy" in modules
        assert "matplotlib" in modules
        assert "pandas" in modules

    def test_multiline_code(self):
        """Test completion in multiline code."""
        provider = AutocompleteProvider()
        code = "x = 1\ny = 2\nimp"
        completions = provider.get_completions(code, cursor_position=len(code))
        assert "import" in completions

    def test_no_completion_for_non_identifier_chars(self):
        """Test that non-identifier characters break completion."""
        provider = AutocompleteProvider()
        completions = provider.get_completions("x + ", cursor_position=4)
        assert completions == []

    def test_underscore_in_identifier(self):
        """Test that underscores are handled correctly in identifiers."""
        provider = AutocompleteProvider()
        state = {"my_variable": 1, "my_value": 2}
        completions = provider.get_completions("my_v", cursor_position=4, state=state)
        assert "my_variable" in completions
        assert "my_value" in completions

    def test_case_sensitive_completion(self):
        """Test that completion is case-sensitive."""
        provider = AutocompleteProvider()
        state = {"MyVar": 1, "myvar": 2}
        completions = provider.get_completions("my", cursor_position=2, state=state)
        assert "myvar" in completions
        assert "MyVar" not in completions
