from __future__ import annotations

import pytest

from platform.server.introspection import (
    MethodExecutionService,
    MethodIntrospector,
    MethodInvocationError,
    MethodResolutionError,
)
from platform.server.state import StateManager


class Sample:
    def __init__(self) -> None:
        self.counter = 0

    def show(self) -> str:
        self.counter += 1
        return f"show-{self.counter}"

    def plot(self) -> str:
        return "plot-result"

    def requires(self, value: int) -> int:
        return value

    def _hidden(self) -> None:
        raise RuntimeError("should not be exposed")


def test_method_introspector_caches_metadata():
    introspector = MethodIntrospector()
    introspector.clear_cache()

    sample = Sample()
    first = introspector.methods_for(sample)
    assert {m.name for m in first} >= {"show", "plot", "requires"}
    assert all(m.name != "_hidden" for m in first)
    requires = next(m for m in first if m.name == "requires")
    assert requires.requires_arguments

    second = introspector.methods_for(sample)
    cache_info = introspector.cache_info()
    assert cache_info.hits >= 1
    assert second == first


def test_method_execution_service_invokes_zero_arg_methods():
    state = StateManager()
    session = state.create_session("example")
    sample = Sample()
    state.set_nested(session, ["root", "sample"], sample)

    service = MethodExecutionService(state)
    metadata = service.describe_methods(session, ["root", "sample"])
    names = {m.name for m in metadata}
    assert names >= {"show", "plot", "requires"}

    result = service.invoke_method(session, ["root", "sample"], "show")
    assert result == "show-1"

    with pytest.raises(MethodInvocationError):
        service.invoke_method(session, ["root", "sample"], "requires")

    with pytest.raises(MethodResolutionError):
        service.describe_methods("missing-session", [])
