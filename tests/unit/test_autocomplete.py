"""Tests for autocomplete functionality."""

import pytest

from platform.server.autocomplete import AutocompleteEngine, CompletionItem


def test_autocomplete_keywords():
    """Test that Python keywords are suggested."""
    engine = AutocompleteEngine()
    completions = engine.get_completions("fo", 2, {})
    
    labels = [c.label for c in completions]
    assert "for" in labels
    
    # Check that it's marked as a keyword
    for_completion = next(c for c in completions if c.label == "for")
    assert for_completion.kind == "keyword"


def test_autocomplete_namespace_variables():
    """Test that namespace variables are suggested."""
    engine = AutocompleteEngine()
    namespace = {"my_var": 42, "my_func": lambda x: x}
    
    completions = engine.get_completions("my", 2, namespace)
    
    labels = [c.label for c in completions]
    assert "my_var" in labels
    assert "my_func" in labels


def test_autocomplete_builtin_functions():
    """Test that builtin functions are suggested."""
    engine = AutocompleteEngine()
    completions = engine.get_completions("pri", 3, {})
    
    labels = [c.label for c in completions]
    assert "print" in labels
    
    print_completion = next(c for c in completions if c.label == "print")
    assert print_completion.kind == "function"


def test_autocomplete_empty_token():
    """Test that empty token returns no completions."""
    engine = AutocompleteEngine()
    completions = engine.get_completions("", 0, {})
    
    assert len(completions) == 0


def test_autocomplete_no_matches():
    """Test that no matches returns empty list."""
    engine = AutocompleteEngine()
    completions = engine.get_completions("zzzzz", 5, {})
    
    assert len(completions) == 0


def test_autocomplete_token_extraction():
    """Test token extraction at various positions."""
    engine = AutocompleteEngine()
    
    # Test extraction at end of word
    token = engine._extract_token_at_position("my_variable", 11)
    assert token == "my_variable"
    
    # Test extraction in middle of word
    token = engine._extract_token_at_position("my_variable", 5)
    assert token == "my_va"
    
    # Test extraction with spaces
    token = engine._extract_token_at_position("x = my_var", 10)
    assert token == "my_var"
    
    # Test extraction at start
    token = engine._extract_token_at_position("variable", 0)
    assert token == ""


def test_autocomplete_skips_private_names():
    """Test that private names (starting with _) are not suggested."""
    engine = AutocompleteEngine()
    namespace = {"public_var": 1, "_private_var": 2, "__dunder__": 3}
    
    completions = engine.get_completions("", 0, namespace)
    labels = [c.label for c in completions]
    
    assert "_private_var" not in labels
    assert "__dunder__" not in labels


def test_autocomplete_completion_item_to_dict():
    """Test CompletionItem serialization."""
    item = CompletionItem(
        label="test",
        kind="variable",
        detail="int",
        documentation="A test variable",
        insert_text="test",
    )
    
    result = item.to_dict()
    assert result["label"] == "test"
    assert result["kind"] == "variable"
    assert result["detail"] == "int"
    assert result["documentation"] == "A test variable"
    assert result["insertText"] == "test"


def test_autocomplete_sorts_by_relevance():
    """Test that completions are sorted with exact matches first."""
    engine = AutocompleteEngine()
    namespace = {"for_loop": 1, "format": 2, "force": 3}
    
    completions = engine.get_completions("for", 3, namespace)
    labels = [c.label for c in completions]
    
    # "for" keyword should come before "for_loop", "format", "force"
    assert labels[0] == "for"
    
    # Other "for*" items should come before unrelated items
    for_items = [l for l in labels if l.startswith("for")]
    assert len(for_items) >= 3


def test_autocomplete_with_multiline_code():
    """Test autocomplete with multi-line code."""
    engine = AutocompleteEngine()
    code = "x = 1\ny = 2\nz = x + "
    namespace = {"x": 1, "y": 2}
    
    # Position at end of the code
    completions = engine.get_completions(code, len(code), namespace)
    labels = [c.label for c in completions]
    
    # Should suggest nothing since we're after a space
    assert len(completions) == 0
    
    # Test with a partial token
    code = "x = 1\ny = 2\nz = xy"
    completions = engine.get_completions(code, len(code), namespace)
    labels = [c.label for c in completions]
    
    # Should not suggest anything starting with "xy"
    assert len([l for l in labels if l.startswith("xy")]) == 0


def test_get_value_kind():
    """Test value kind detection."""
    engine = AutocompleteEngine()
    
    # Test function
    def my_func():
        pass
    
    assert engine._get_value_kind(my_func) == "function"
    
    # Test class
    class MyClass:
        pass
    
    assert engine._get_value_kind(MyClass) == "class"
    
    # Test variable
    assert engine._get_value_kind(42) == "variable"
    assert engine._get_value_kind("string") == "variable"
