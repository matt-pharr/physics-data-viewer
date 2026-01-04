"""Session and nested state management utilities."""

from __future__ import annotations

import json
import uuid
from copy import deepcopy
from typing import Any, Callable, Dict, Iterable, Optional, Tuple

StateObserver = Callable[[str, Tuple[str, ...], Any, str], None]


class StateManager:
    """Manage session-scoped state with serialization helpers."""

    def __init__(self) -> None:
        self._sessions: Dict[str, Dict[str, Any]] = {}
        self._observers: list[StateObserver] = []

    def create_session(self, session_id: Optional[str] = None) -> str:
        """Create a new session or ensure an existing session is registered."""
        sid = session_id or str(uuid.uuid4())
        self._sessions.setdefault(sid, {})
        self._notify("create", (), None, sid)
        return sid

    def get_session_state(self, session_id: str) -> Dict[str, Any]:
        """Return a deep copy of the session state."""
        return deepcopy(self._sessions.get(session_id, {}))

    def get_session_state_ref(self, session_id: str) -> Dict[str, Any]:
        """Return a mutable reference to the session state without copying."""
        return self._sessions.setdefault(session_id, {})

    def has_session(self, session_id: str) -> bool:
        """Check whether a session exists."""
        return session_id in self._sessions

    def update_session_state(self, session_id: str, state: Dict[str, Any]) -> None:
        """Replace the session state with the provided mapping."""
        if not isinstance(state, dict):
            raise ValueError("State must be a dictionary.")
        self._sessions[session_id] = deepcopy(state)
        self._notify("replace", (), deepcopy(state), session_id)

    def clear_session(self, session_id: str) -> None:
        """Remove a session and its stored state."""
        removed = self._sessions.pop(session_id, None)
        if removed is not None:
            self._notify("clear", (), None, session_id)

    def set_nested(self, session_id: str, path: Iterable[str], value: Any) -> None:
        """Update a nested key within the session state."""
        path_list = list(path)
        if not path_list:
            raise ValueError("Path must contain at least one key.")

        state = self._sessions.setdefault(session_id, {})
        cursor: Dict[str, Any] = state
        for key in path_list[:-1]:
            child = cursor.setdefault(key, {})
            if not isinstance(child, dict):
                raise ValueError("Cannot descend into non-dictionary state segment.")
            cursor = child
        cursor[path_list[-1]] = value
        self._sessions[session_id] = state
        self._notify("set", tuple(path_list), value, session_id)

    def to_json(self) -> str:
        """Serialize all session states to JSON."""
        return json.dumps(self._sessions)

    def load_json(self, data: str) -> None:
        """Load session states from a JSON payload."""
        loaded = json.loads(data or "{}")
        if not isinstance(loaded, dict):
            raise ValueError("Serialized state must be a dictionary mapping.")
        self._sessions = loaded

    def add_observer(self, observer: StateObserver) -> None:
        """Register an observer notified on state mutations."""
        self._observers.append(observer)

    def _notify(self, action: str, path: Tuple[str, ...], value: Any, session_id: str) -> None:
        for observer in self._observers:
            observer(action, path, value, session_id)
