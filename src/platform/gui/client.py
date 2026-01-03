"""HTTP client used by the frontend to communicate with the backend server."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional, Sequence

import httpx


class FrontendConnectionError(RuntimeError):
    """Raised when the frontend cannot reach the backend."""


@dataclass
class ExecuteResult:
    """Structured response from backend execute endpoint."""

    session_id: str
    stdout: str
    stderr: str
    state: Dict[str, Any]
    error: Optional[str] = None

    @property
    def success(self) -> bool:
        """True if execution completed without reported error."""
        return self.error is None


@dataclass(frozen=True)
class MethodInfo:
    """Metadata describing a backend method."""

    name: str
    doc: Optional[str]
    requires_arguments: bool


@dataclass
class InvokeResult:
    """Result of invoking a backend method."""

    method_name: str
    result: Any
    result_type: str
    error: Optional[str] = None
    traceback: Optional[str] = None


class BackendClient:
    """Lightweight HTTP client for backend interaction."""

    def __init__(self, base_url: str, client: Optional[httpx.AsyncClient] = None) -> None:
        self.base_url = base_url.rstrip("/")
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(base_url=self.base_url)

    async def connect(self) -> str:
        """Create or reuse a session to verify backend connectivity."""
        try:
            response = await self._client.post("/sessions", json=None)
            response.raise_for_status()
        except httpx.RequestError as exc:
            raise FrontendConnectionError(f"Unable to reach backend at {self.base_url}. Is it running?") from exc
        except httpx.HTTPStatusError as exc:  # pragma: no cover - defensive
            raise FrontendConnectionError(f"Backend at {self.base_url} returned an error: {exc.response.status_code}") from exc
        payload = response.json()
        return payload["session_id"]

    async def execute(self, code: str, *, session_id: Optional[str] = None, timeout: float = 5.0) -> ExecuteResult:
        """Execute Python code on the backend."""
        request_payload: Dict[str, Any] = {"code": code, "timeout": timeout}
        if session_id is not None:
            request_payload["session_id"] = session_id

        response = await self._client.post("/execute", json=request_payload)
        response.raise_for_status()
        data = response.json()
        return ExecuteResult(
            session_id=data["session_id"],
            stdout=data["stdout"],
            stderr=data["stderr"],
            state=data["state"],
            error=data.get("error"),
        )

    async def list_methods(self, session_id: str, path: Sequence[str]) -> list[MethodInfo]:
        """Return public methods for an object stored in backend state."""
        response = await self._client.post("/introspect", json={"session_id": session_id, "path": list(path)})
        response.raise_for_status()
        data = response.json()
        return [
            MethodInfo(
                name=entry["name"],
                doc=entry.get("doc"),
                requires_arguments=entry.get("requires_arguments", False),
            )
            for entry in data.get("methods", [])
        ]

    async def invoke_method(self, session_id: str, path: Sequence[str], method_name: str) -> InvokeResult:
        """Invoke a method by name on the backend."""
        response = await self._client.post(
            "/invoke", json={"session_id": session_id, "path": list(path), "method_name": method_name}
        )
        data = response.json()
        # Do not raise for status so error payloads can propagate to the caller.
        return InvokeResult(
            method_name=data.get("method_name", method_name),
            result=data.get("result"),
            result_type=data.get("result_type", "object"),
            error=data.get("error"),
            traceback=data.get("traceback"),
        )

    async def get_state(self, session_id: str) -> Dict[str, Any]:
        """Fetch the current state for a session."""
        response = await self._client.get(f"/state/{session_id}")
        response.raise_for_status()
        return response.json()

    async def get_completions(
        self, session_id: str, code: str, cursor_position: Optional[int] = None
    ) -> list[str]:
        """Get autocomplete suggestions for the given code."""
        request_payload: Dict[str, Any] = {"session_id": session_id, "code": code}
        if cursor_position is not None:
            request_payload["cursor_position"] = cursor_position

        response = await self._client.post("/autocomplete", json=request_payload)
        response.raise_for_status()
        data = response.json()
        return data.get("completions", [])

    async def aclose(self) -> None:
        """Close the underlying HTTP client if owned by this instance."""
        if self._owns_client:
            await self._client.aclose()
