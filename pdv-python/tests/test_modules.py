"""
pdv-python/tests/test_modules.py — Tests for the handler registry in pdv.modules.

Tests cover:
1. @handle decorator registers a handler.
2. has_handler_for matches exact type.
3. has_handler_for matches subclass via MRO.
4. Last registration wins (with warning).
5. dispatch_handler calls the registered function.
6. dispatch_handler returns False when no handler matches.
7. get_handler_registry returns expected snapshot.
8. clear_handlers empties the registry.

Reference: ARCHITECTURE.md §3.4
"""

import warnings

import pytest

from pdv.modules import (
    clear_handlers,
    dispatch_handler,
    get_handler_registry,
    handle,
    has_handler_for,
)


@pytest.fixture(autouse=True)
def _clean_registry():
    """Clear the handler registry before and after each test."""
    clear_handlers()
    yield
    clear_handlers()


class _Base:
    pass


class _Child(_Base):
    pass


class _Unrelated:
    pass


def test_handle_decorator_registers_handler():
    """@handle(cls) should register the decorated function."""

    @handle(_Base)
    def on_base(obj, path, tree):
        pass

    registry = get_handler_registry()
    assert len(registry) == 1
    class_name = f"{_Base.__module__}.{_Base.__qualname__}"
    assert class_name in registry
    assert registry[class_name] == on_base.__qualname__


def test_has_handler_for_exact_type():
    """has_handler_for should match when the exact type is registered."""

    @handle(_Base)
    def on_base(obj, path, tree):
        pass

    assert has_handler_for(_Base()) is True
    assert has_handler_for(_Unrelated()) is False


def test_has_handler_for_subclass_via_mro():
    """has_handler_for should match subclasses via MRO."""

    @handle(_Base)
    def on_base(obj, path, tree):
        pass

    assert has_handler_for(_Child()) is True


def test_last_registration_wins():
    """Registering a handler for the same type should overwrite with a warning."""

    @handle(_Base)
    def first(obj, path, tree):
        pass

    with warnings.catch_warnings(record=True) as w:
        warnings.simplefilter("always")

        @handle(_Base)
        def second(obj, path, tree):
            pass

        assert len(w) == 1
        assert "overwritten" in str(w[0].message).lower()

    registry = get_handler_registry()
    class_name = f"{_Base.__module__}.{_Base.__qualname__}"
    assert registry[class_name] == second.__qualname__


def test_dispatch_handler_calls_function():
    """dispatch_handler should call the registered handler and return dispatched=True."""
    called_with = []

    @handle(_Base)
    def on_base(obj, path, tree):
        called_with.append((obj, path, tree))

    obj = _Base()
    result = dispatch_handler(obj, "some.path", {"fake": "tree"})
    assert result == {"dispatched": True}
    assert len(called_with) == 1
    assert called_with[0][0] is obj
    assert called_with[0][1] == "some.path"


def test_dispatch_handler_no_handler_returns_false():
    """dispatch_handler should return dispatched=False when no handler matches."""
    result = dispatch_handler(_Unrelated(), "some.path", {})
    assert result["dispatched"] is False
    assert "error" in result


def test_get_handler_registry():
    """get_handler_registry should return a snapshot of registered handlers."""

    @handle(_Base)
    def on_base(obj, path, tree):
        pass

    @handle(_Unrelated)
    def on_unrelated(obj, path, tree):
        pass

    registry = get_handler_registry()
    assert len(registry) == 2


def test_clear_handlers():
    """clear_handlers should empty the registry."""

    @handle(_Base)
    def on_base(obj, path, tree):
        pass

    assert len(get_handler_registry()) == 1
    clear_handlers()
    assert len(get_handler_registry()) == 0
