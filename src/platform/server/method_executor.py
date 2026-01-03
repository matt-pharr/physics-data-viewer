"""Enhanced method execution with result classification and traceback capture."""

from __future__ import annotations

import logging
import traceback
from dataclasses import dataclass
from typing import Any, Optional, Sequence

from .introspection import MethodExecutionService, MethodIntrospector, MethodInvocationError, MethodResolutionError
from .state import StateManager

LOG = logging.getLogger(__name__)


@dataclass
class MethodExecutionResult:
    """Structured response describing a method invocation."""

    method_name: str
    result: Any
    result_type: str
    error: Optional[str] = None
    traceback: Optional[str] = None

    @property
    def succeeded(self) -> bool:
        """True when the invocation completed without error."""
        return self.error is None


class MethodExecutor:
    """Invoke backend methods and classify results for display."""

    def __init__(
        self,
        state_manager: StateManager,
        introspector: Optional[MethodIntrospector] = None,
        service: Optional[MethodExecutionService] = None,
    ) -> None:
        self.service = service or MethodExecutionService(state_manager, introspector)
        self._log = LOG

    def describe_methods(self, session_id: str, path: Sequence[str]):
        """Proxy to method discovery to keep API compatibility."""
        return self.service.describe_methods(session_id, path)

    def invoke(self, session_id: str, path: Sequence[str], method_name: str) -> MethodExecutionResult:
        """Invoke a method and capture structured outcome, including tracebacks on failure."""
        try:
            result = self.service.invoke_method(session_id, path, method_name)
            return MethodExecutionResult(
                method_name=method_name,
                result=result,
                result_type=self._classify_result(method_name, result),
            )
        except (MethodResolutionError, MethodInvocationError) as exc:
            formatted_tb = self._format_traceback(exc)
            self._log.debug("Invocation of %s failed: %s", method_name, exc)
            return MethodExecutionResult(
                method_name=method_name,
                result=None,
                result_type="error",
                error=str(exc),
                traceback=formatted_tb,
            )

    def _classify_result(self, method_name: str, result: Any) -> str:
        """Map raw results into semantic categories for display."""
        if isinstance(result, (bytes, bytearray)):
            return "image"
        if method_name == "plot":
            return "plot"
        if method_name == "show":
            return "text"
        if isinstance(result, str):
            return "text"
        if isinstance(result, (dict, list, tuple, set)):
            return "data"
        return "object"

    @staticmethod
    def _format_traceback(exc: BaseException) -> str:
        """Format the traceback, preferring the original cause when available."""
        root = exc.__cause__ or exc
        return "".join(traceback.format_exception(type(root), root, root.__traceback__))


__all__ = ["MethodExecutor", "MethodExecutionResult"]
