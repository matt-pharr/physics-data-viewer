"""Lightweight publish/subscribe system for inter-module communication."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple
from uuid import uuid4

from platform.modules.base import BaseModule
from platform.modules.manifest import ModuleManifest
from platform.server.state import StateManager
from platform.state.project_tree import ProjectTree

logger = logging.getLogger(__name__)

EventCallback = Callable[["Event"], Any]
EventFilter = Callable[["Event"], bool]


@dataclass
class Event:
    """Represents a published event."""

    type: str
    payload: Any
    source: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class _Subscription:
    id: str
    event_type: str
    callback: EventCallback
    predicate: Optional[EventFilter]
    module: Optional[str]


class EventSystem:
    """Central event bus for modules."""

    def __init__(self) -> None:
        self._subscribers: Dict[str, Dict[str, _Subscription]] = {}
        self._modules: Dict[str, BaseModule] = {}
        self._manifests: Dict[str, ModuleManifest] = {}
        self._project_tree_attached = False
        self._state_manager: Optional[StateManager] = None
        self._token_index: Dict[str, str] = {}

    def register_module(self, module: BaseModule, manifest: ModuleManifest) -> None:
        """Register a module for dependency injection and routing."""
        if manifest.name in self._modules:
            return

        missing = [dep for dep in manifest.dependencies if dep not in self._modules]
        if missing:
            raise ValueError(f"Missing dependencies for {manifest.name}: {', '.join(sorted(missing))}")

        self._modules[manifest.name] = module
        self._manifests[manifest.name] = manifest

    def resolve_dependency(self, requester: str, dependency: str) -> BaseModule:
        """Return a registered dependency for a requester, enforcing manifest rules."""
        manifest = self._manifests.get(requester)
        if manifest is None:
            raise KeyError(f"Unknown module {requester}")
        if dependency not in manifest.dependencies:
            raise PermissionError(f"{requester} is not allowed to access undeclared dependency {dependency}")

        target_manifest = self._manifests.get(dependency)
        if target_manifest and self._detect_cycle(requester, dependency):
            raise ValueError(f"Circular dependency detected between {requester} and {dependency}")

        target = self._modules.get(dependency)
        if target is None:
            raise KeyError(f"Dependency {dependency} is not registered")
        return target

    def subscribe(
        self,
        event_type: str,
        callback: EventCallback,
        *,
        predicate: Optional[EventFilter] = None,
        module: Optional[str] = None,
    ) -> str:
        """Subscribe to an event type and return a subscription token."""
        token = str(uuid4())
        subscribers = self._subscribers.setdefault(event_type, {})
        subscribers[token] = _Subscription(
            id=token,
            event_type=event_type,
            callback=callback,
            predicate=predicate,
            module=module,
        )
        self._token_index[token] = event_type
        return token

    def unsubscribe(self, token: str) -> None:
        """Remove a subscription if present."""
        event_type = self._token_index.pop(token, None)
        if event_type is not None:
            self._subscribers.get(event_type, {}).pop(token, None)
        else:
            found = False
            for subscribers in self._subscribers.values():
                if token in subscribers:
                    subscribers.pop(token, None)
                    found = True
            if found:
                logger.warning("Token %s missing from index but present in subscribers", token)

    def publish(
        self, event_type: str, payload: Any, *, source: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None
    ) -> List[Any]:
        """Publish an event to all matching subscribers."""
        event = Event(type=event_type, payload=payload, source=source, metadata=dict(metadata or {}))
        results: List[Any] = []
        for bucket in (self._subscribers.get(event_type, {}), self._subscribers.get("*", {})):
            for subscription in bucket.values():
                if subscription.predicate and not subscription.predicate(event):
                    continue
                results.append(subscription.callback(event))
        return results

    def attach_project_tree(self, project_tree: ProjectTree) -> None:
        """Attach to project tree changes for automatic notifications."""
        if self._project_tree_attached:
            return
        project_tree.add_observer(self._on_tree_change)
        self._project_tree_attached = True

    def attach_state_manager(self, state_manager: StateManager) -> None:
        """Attach to state manager updates for synchronization events."""
        if self._state_manager is state_manager:
            return
        if self._state_manager is not None:
            return
        self._state_manager = state_manager
        state_manager.add_observer(self._on_state_change)

    def _on_tree_change(self, action: str, path: Tuple[str, ...], value: Any) -> None:
        self.publish(
            "project_tree",
            {"path": tuple(path), "value": value, "action": action},
            metadata={"action": action, "path": tuple(path)},
        )

    def _on_state_change(self, action: str, path: Iterable[str], value: Any, session_id: str) -> None:
        path_tuple = tuple(path)
        self.publish(
            "session_state",
            {"session": session_id, "path": path_tuple, "value": value, "action": action},
            metadata={"action": action, "session": session_id, "path": path_tuple},
        )

    def _detect_cycle(self, requester: str, dependency: str) -> bool:
        """Detect whether resolving dependency would introduce a cycle."""
        to_visit = [dependency]
        seen = set()
        while to_visit:
            current = to_visit.pop()
            if current == requester:
                return True
            if current in seen:
                continue
            seen.add(current)
            manifest = self._manifests.get(current)
            if manifest:
                to_visit.extend(manifest.dependencies)
        return False


__all__ = ["Event", "EventSystem"]
