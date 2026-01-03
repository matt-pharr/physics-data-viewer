"""HTTP API routes for the backend server."""

from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, HTTPException, Request, status
from pydantic import BaseModel, Field

from .executor import ExecutionError, ExecutionResult, SubprocessExecutor
from .state import StateManager

router = APIRouter()


@router.get("/")
def root() -> Dict[str, str]:
    """Health endpoint for root path."""
    return {"status": "ok"}


class SessionResponse(BaseModel):
    """Response payload when creating a session."""

    session_id: str


class ExecuteRequest(BaseModel):
    """Payload for executing Python code."""

    code: str = Field(..., min_length=1, max_length=10000)
    session_id: Optional[str] = None
    timeout: float = Field(default=5.0, gt=0, le=60.0)


class ExecuteResponse(BaseModel):
    """Response containing execution output and updated state."""

    session_id: str
    stdout: str
    stderr: str
    state: Dict[str, Any]
    error: Optional[str] = None


def _get_state_manager(request: Request) -> StateManager:
    manager = getattr(request.app.state, "state_manager", None)
    if manager is None:
        raise HTTPException(status_code=500, detail="State manager unavailable")
    return manager


def _get_executor(request: Request) -> SubprocessExecutor:
    executor = getattr(request.app.state, "executor", None)
    if executor is None:
        raise HTTPException(status_code=500, detail="Executor unavailable")
    return executor


@router.post("/sessions", response_model=SessionResponse)
def create_session(request: Request, session_id: Optional[str] = Body(default=None)) -> SessionResponse:
    """Create a new session or register an existing session id."""
    manager = _get_state_manager(request)
    sid = manager.create_session(session_id)
    return SessionResponse(session_id=sid)


@router.get("/state/{session_id}", response_model=Dict[str, Any])
def get_state(session_id: str, request: Request) -> Dict[str, Any]:
    """Retrieve the current state for a session."""
    manager = _get_state_manager(request)
    if not manager.has_session(session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    return manager.get_session_state(session_id)


@router.post("/execute", response_model=ExecuteResponse)
def execute(request: Request, payload: ExecuteRequest) -> ExecuteResponse:
    """Execute Python code in a session-specific subprocess."""
    executor = _get_executor(request)
    manager = _get_state_manager(request)
    session_id = payload.session_id or manager.create_session()

    try:
        result: ExecutionResult = executor.execute(
            code=payload.code,
            session_id=session_id,
            timeout=payload.timeout,
        )
    except ExecutionError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    return ExecuteResponse(
        session_id=session_id,
        stdout=result.stdout,
        stderr=result.stderr,
        state=result.state,
        error=result.error,
    )
