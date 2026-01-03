"""Subprocess-backed Python execution engine with session isolation."""

from __future__ import annotations

import json
import logging
import subprocess
import sys
from dataclasses import dataclass
from typing import Any, Dict, Optional

from .state import StateManager

LOG = logging.getLogger(__name__)

_EXECUTOR_SNIPPET = r"""
import contextlib
import io
import json
import sys
import traceback

state = json.loads(sys.argv[1])
code = sys.stdin.read()
stdout = io.StringIO()
stderr = io.StringIO()
globals_dict = {"__builtins__": __builtins__}
locals_dict = dict(state)
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
    "state": locals_dict,
    "error": error,
}

print(json.dumps(result, default=str))
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

    def execute(self, code: str, session_id: str, timeout: float = 1.0) -> ExecutionResult:
        """Execute Python code in an isolated subprocess for the given session."""
        if not code:
            raise ExecutionError("Code to execute must not be empty.")

        session = self.state_manager.create_session(session_id)
        initial_state = self.state_manager.get_session_state(session)
        serialized_state = json.dumps(initial_state, default=str)

        try:
            completed = subprocess.run(
                [sys.executable, "-c", _EXECUTOR_SNIPPET, serialized_state],
                input=code,
                capture_output=True,
                check=False,
                text=True,
                timeout=timeout,
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

        new_state = payload.get("state") or {}
        self.state_manager.update_session_state(session, new_state)

        return ExecutionResult(
            stdout=payload.get("stdout", ""),
            stderr=payload.get("stderr", ""),
            state=new_state,
            error=payload.get("error"),
        )
