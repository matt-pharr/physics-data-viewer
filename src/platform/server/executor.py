"""Subprocess-backed Python execution engine with session isolation."""

from __future__ import annotations

import base64
import json
import logging
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from platform.state.project_io import load_project_tree, serialize_project_tree
from platform.state.project_tree import ProjectTree, Tree, get_project_tree

from .state import StateManager

LOG = logging.getLogger(__name__)

_EXECUTOR_SNIPPET = r"""
import base64
import contextlib
import io
import json
import sys
import traceback

try:
    from platform.state.project_tree import ProjectTree, get_project_tree
    from platform.state.project_io import load_project_tree, serialize_project_tree
except Exception:  # pragma: no cover - defensive
    ProjectTree = None
    get_project_tree = None
    load_project_tree = None
    serialize_project_tree = None

def _to_jsonable(value):
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {k: _to_jsonable(v) for k, v in value.items()}
    if ProjectTree is not None and serialize_project_tree and isinstance(value, ProjectTree):
        encoded = base64.b64encode(serialize_project_tree(value)).decode("ascii")
        return {"__pdv_kind__": "project_tree", "payload": encoded}
    return str(value)

def _rehydrate(value):
    if isinstance(value, dict) and value.get("__pdv_kind__") == "project_tree" and get_project_tree:
        payload = value.get("payload")
        tree = get_project_tree()
        if payload and load_project_tree:
            load_project_tree(base64.b64decode(payload), target=tree)
        return tree
    if isinstance(value, dict):
        return {k: _rehydrate(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_rehydrate(v) for v in value]
    return value

state = json.loads(sys.argv[1])
code = sys.stdin.read()
stdout = io.StringIO()
stderr = io.StringIO()
globals_dict = {"__builtins__": __builtins__}
locals_dict = _rehydrate(dict(state))
error = None

with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
    try:
        exec(code, globals_dict, locals_dict)
    except Exception as exc:  # noqa: BLE001 - propagate through structured result
        error = f"{exc.__class__.__name__}: {exc}"
        traceback.print_exc()

result = {
    "stdout": stdout.getvalue(),
    "stderr": stderr.getvalue(),
    "state": _to_jsonable(locals_dict),
    "error": error,
}

print(json.dumps(result))
"""


class ExecutionError(Exception):
    """Raised when a subprocess execution cannot be completed."""


@dataclass
class ExecutionResult:
    """Structured result from executing code in a subprocess."""

    stdout: str
    stderr: str
    state: Dict[str, Any]
    error: Optional[str] = None

    @property
    def success(self) -> bool:
        """Return True when execution completed without errors."""
        return self.error is None


class SubprocessExecutor:
    """Execute Python code safely in a subprocess with session state."""

    def __init__(self, state_manager: StateManager) -> None:
        self.state_manager = state_manager

    def start(self) -> None:
        """Hook for symmetry; no-op for the current implementation."""
        LOG.debug("SubprocessExecutor started.")

    def shutdown(self) -> None:
        """Cleanup hook; currently a no-op."""
        LOG.debug("SubprocessExecutor shutdown.")

    def execute(self, code: str, session_id: str, timeout: float = 5.0) -> ExecutionResult:
        """Execute Python code in an isolated subprocess for the given session."""
        if not code:
            raise ExecutionError("Code to execute must not be empty.")

        session = self.state_manager.create_session(session_id)
        initial_state = self._prepare_state(self.state_manager.get_session_state(session))
        serialized_state = json.dumps(initial_state, default=str)

        env = os.environ.copy()
        src_root = Path(__file__).resolve().parents[2]
        env["PYTHONPATH"] = os.pathsep.join([str(src_root), env.get("PYTHONPATH", "")])

        try:
            completed = subprocess.run(
                [sys.executable, "-c", _EXECUTOR_SNIPPET, serialized_state],
                input=code,
                capture_output=True,
                check=False,
                text=True,
                timeout=timeout,
                env=env,
            )
        except subprocess.TimeoutExpired as exc:
            LOG.error("Execution timed out for session %s", session)
            raise ExecutionError("Execution timed out") from exc

        if not completed.stdout:
            LOG.error("Subprocess produced no output. stderr=%s", completed.stderr)
            raise ExecutionError("Failed to capture execution result.")

        try:
            payload = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            LOG.error("Failed to decode execution output: %s", completed.stdout)
            raise ExecutionError("Execution output was not valid JSON.") from exc

        hydrated_state = self._rehydrate_state(payload.get("state") or {})
        storable_state = self._prepare_state(hydrated_state)
        self.state_manager.update_session_state(session, storable_state)
        response_state = storable_state

        if payload.get("error"):
            LOG.warning("Execution returned error for session %s: %s", session, payload["error"])

        return ExecutionResult(
            stdout=payload.get("stdout", ""),
            stderr=payload.get("stderr", ""),
            state=response_state,
            error=payload.get("error"),
        )

    @staticmethod
    def _is_project_tree(value: Any) -> bool:
        return isinstance(value, ProjectTree)

    def _prepare_state(self, state: Dict[str, Any]) -> Dict[str, Any]:
        """Replace project tree objects with a sentinel for safe serialization."""
        def _transform(val: Any) -> Any:
            if self._is_project_tree(val):
                encoded = base64.b64encode(serialize_project_tree(val)).decode("ascii")
                return {"__pdv_kind__": "project_tree", "payload": encoded}
            if isinstance(val, dict):
                return {k: _transform(v) for k, v in val.items()}
            if isinstance(val, list):
                return [_transform(v) for v in val]
            return val

        return {k: _transform(v) for k, v in state.items()}

    def _rehydrate_state(self, state: Dict[str, Any]) -> Dict[str, Any]:
        """Restore sentinels to live objects after execution."""
        def _rehydrate(val: Any) -> Any:
            if isinstance(val, dict) and val.get("__pdv_kind__") == "project_tree":
                payload = val.get("payload")
                tree = get_project_tree()
                if payload:
                    load_project_tree(base64.b64decode(payload), target=tree)
                return tree
            if isinstance(val, dict):
                return {k: _rehydrate(v) for k, v in val.items()}
            if isinstance(val, list):
                return [_rehydrate(v) for v in val]
            return val

        if not isinstance(state, dict):
            return {}
        return {k: _rehydrate(v) for k, v in state.items()}
