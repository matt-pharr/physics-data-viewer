"""Backend utilities for method introspection and invocation."""

from __future__ import annotations

import inspect
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Callable, Iterable, List, Sequence

from .state import StateManager


@dataclass(frozen=True)
class MethodMetadata:
    """Structured description of an object's callable attribute."""

    name: str
    doc: str | None
    requires_arguments: bool


class MethodResolutionError(RuntimeError):
    """Raised when an object cannot be located for introspection."""


class MethodInvocationError(RuntimeError):
    """Raised when a method cannot be invoked successfully."""


def _is_public(name: str) -> bool:
    return not name.startswith("_")


def _requires_additional_arguments(fn: Any) -> bool:
    try:
        signature = inspect.signature(fn)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return True

    required = [
        param
        for param in signature.parameters.values()
        if param.default is inspect.Parameter.empty
        and param.kind
        in (
            inspect.Parameter.POSITIONAL_ONLY,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            inspect.Parameter.KEYWORD_ONLY,
        )
    ]
    if not required:
        return False
    if len(required) == 1 and required[0].name in {"self", "cls"}:
        return False
    return True


@lru_cache(maxsize=128)
def _introspect_type(klass: type) -> List[MethodMetadata]:
    """Cached inspection of methods defined on a class."""
    methods: List[MethodMetadata] = []
    for name, member in inspect.getmembers(klass, predicate=inspect.isroutine):
        if not _is_public(name):
            continue
        requires_args = _requires_additional_arguments(member)
        methods.append(MethodMetadata(name=name, doc=inspect.getdoc(member), requires_arguments=requires_args))
    methods.sort(key=lambda m: m.name)
    return methods


class MethodIntrospector:
    """Discover callable methods on objects with lightweight caching."""

    def methods_for(self, obj: Any) -> List[MethodMetadata]:
        """Return public method metadata for an object."""
        base = list(_introspect_type(type(obj)))
        seen = {method.name for method in base}

        # Include instance-level callables that may not appear on the class definition.
        for name, member in inspect.getmembers(obj, predicate=callable):
            if name in seen or not _is_public(name):
                continue
            requires_args = _requires_additional_arguments(member)
            base.append(MethodMetadata(name=name, doc=inspect.getdoc(member), requires_arguments=requires_args))
            seen.add(name)

        base.sort(key=lambda m: m.name)
        return base

    def cache_info(self):
        """Expose cache stats for testing and observability."""
        return _introspect_type.cache_info()

    def clear_cache(self) -> None:
        """Clear cached metadata."""
        _introspect_type.cache_clear()


class MethodExecutionService:
    """Resolve and invoke methods against session state safely."""

    def __init__(self, state_manager: StateManager, introspector: MethodIntrospector | None = None) -> None:
        self.state_manager = state_manager
        self.introspector = introspector or MethodIntrospector()

    def describe_methods(self, session_id: str, path: Sequence[str]) -> List[MethodMetadata]:
        """Return cached metadata for the object addressed by path."""
        obj = self._resolve_object(session_id, path)
        return self.introspector.methods_for(obj)

    def invoke_method(self, session_id: str, path: Sequence[str], method_name: str) -> Any:
        """Invoke a zero-argument method on the addressed object."""
        obj = self._resolve_object(session_id, path)
        methods = {meta.name: meta for meta in self.introspector.methods_for(obj)}
        metadata = methods.get(method_name)
        if metadata is None:
            raise MethodInvocationError(f"Method '{method_name}' not available on target.")
        if metadata.requires_arguments:
            raise MethodInvocationError(f"Method '{method_name}' requires arguments and cannot be auto-invoked.")

        method = getattr(obj, method_name, None)
        if method is None or not callable(method):
            raise MethodInvocationError(f"Method '{method_name}' is not callable.")
        if _requires_additional_arguments(method):
            raise MethodInvocationError(f"Method '{method_name}' requires arguments and cannot be auto-invoked.")

        try:
            return method()
        except Exception as exc:  # noqa: BLE001 - propagate as structured error
            raise MethodInvocationError(f"Method '{method_name}' failed: {exc}") from exc

    def _resolve_object(self, session_id: str, path: Sequence[str]) -> Any:
        if not self.state_manager.has_session(session_id):
            raise MethodResolutionError(f"Session '{session_id}' not found.")

        target: Any = self.state_manager.get_session_state_ref(session_id)
        for segment in path:
            target = self._descend(target, segment)
        return target

    def _descend(self, current: Any, segment: str) -> Any:
        if isinstance(current, dict):
            if segment not in current:
                raise MethodResolutionError(f"Key '{segment}' not found while resolving path.")
            return current[segment]
        if isinstance(current, (list, tuple)):
            try:
                index = int(segment)
            except ValueError as exc:
                raise MethodResolutionError(f"Index '{segment}' is not valid for sequence access.") from exc
            try:
                return current[index]
            except IndexError as exc:  # pragma: no cover - defensive guard
                raise MethodResolutionError(f"Index '{segment}' out of range.") from exc
        raise MethodResolutionError(f"Cannot descend into object of type {type(current).__name__!s}.")


__all__ = [
    "MethodMetadata",
    "MethodIntrospector",
    "MethodExecutionService",
    "MethodInvocationError",
    "MethodResolutionError",
]
