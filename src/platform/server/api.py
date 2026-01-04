"""HTTP API routes for the backend server."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, File, HTTPException, Request, UploadFile, status
from fastapi.responses import Response
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, Field

from .autocomplete import AutocompleteEngine, CompletionItem
from .executor import ExecutionError, ExecutionResult, SubprocessExecutor
from .introspection import MethodResolutionError
from .method_executor import MethodExecutionResult, MethodExecutor
from .state import StateManager
from platform.state.project_tree import ProjectTree
from platform.state.project_io import ProjectIOError, load_project_tree, serialize_project_tree

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


class MethodInfo(BaseModel):
    """Metadata exposed for a single method."""

    name: str
    doc: Optional[str] = None
    requires_arguments: bool = False


class IntrospectRequest(BaseModel):
    """Payload describing the target object to introspect."""

    session_id: str
    path: List[str] = Field(default_factory=list)


class IntrospectResponse(BaseModel):
    """Response containing available method metadata."""

    session_id: str
    path: List[str]
    methods: List[MethodInfo]


class InvokeRequest(BaseModel):
    """Payload to execute a method on a target object."""

    session_id: str
    path: List[str] = Field(default_factory=list)
    method_name: str = Field(..., min_length=1)


class InvokeResponse(BaseModel):
    """Response returned after invoking a method."""

    session_id: str
    path: List[str]
    method_name: str
    result: Any
    result_type: str = "object"
    error: Optional[str] = None
    traceback: Optional[str] = None


class AutocompleteRequest(BaseModel):
    """Payload for requesting autocomplete suggestions."""

    code: str
    position: int = Field(..., ge=0)
    session_id: str


class CompletionItemResponse(BaseModel):
    """A single completion suggestion."""

    label: str
    kind: str
    detail: Optional[str] = None
    documentation: Optional[str] = None
    insertText: Optional[str] = None


class AutocompleteResponse(BaseModel):
    """Response containing completion suggestions."""

    completions: List[CompletionItemResponse]


class ProjectLoadResponse(BaseModel):
    """Response returned after loading a project archive."""

    status: str
    root_keys: List[str]


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


def _get_method_executor(request: Request) -> MethodExecutor:
    executor: Optional[MethodExecutor] = getattr(request.app.state, "method_execution", None)
    if executor is None:
        raise HTTPException(status_code=500, detail="Method execution unavailable")
    return executor


def _get_autocomplete_engine(request: Request) -> AutocompleteEngine:
    engine: Optional[AutocompleteEngine] = getattr(request.app.state, "autocomplete_engine", None)
    if engine is None:
        raise HTTPException(status_code=500, detail="Autocomplete engine unavailable")
    return engine


def _get_project_tree(request: Request) -> ProjectTree:
    tree: Optional[ProjectTree] = getattr(request.app.state, "project_tree", None)
    if tree is None:
        raise HTTPException(status_code=500, detail="Project tree unavailable")
    return tree


@router.post("/sessions", response_model=SessionResponse)
def create_session(request: Request, session_id: Optional[str] = Body(default=None, embed=True)) -> SessionResponse:
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


@router.post("/introspect", response_model=IntrospectResponse)
def introspect_methods(request: Request, payload: IntrospectRequest) -> IntrospectResponse:
    """Return available methods for the object located at the provided path."""
    executor = _get_method_executor(request)
    try:
        methods = executor.describe_methods(payload.session_id, payload.path)
    except MethodResolutionError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    method_payloads: List[MethodInfo] = []
    for method in methods:
        method_payloads.append(
            MethodInfo(name=method.name, doc=method.doc, requires_arguments=method.requires_arguments)
        )
    return IntrospectResponse(session_id=payload.session_id, path=payload.path, methods=method_payloads)


@router.post("/invoke", response_model=InvokeResponse)
def invoke_method(request: Request, payload: InvokeRequest) -> InvokeResponse:
    """Invoke a zero-argument method on the targeted object."""
    executor = _get_method_executor(request)
    result: MethodExecutionResult = executor.invoke(payload.session_id, payload.path, payload.method_name)
    return InvokeResponse(
        session_id=payload.session_id,
        path=payload.path,
        method_name=payload.method_name,
        result=jsonable_encoder(result.result),
        result_type=result.result_type,
        error=result.error,
        traceback=result.traceback,
    )


@router.post("/autocomplete", response_model=AutocompleteResponse)
def autocomplete(request: Request, payload: AutocompleteRequest) -> AutocompleteResponse:
    """Get autocomplete suggestions for Python code."""
    engine = _get_autocomplete_engine(request)
    manager = _get_state_manager(request)
    
    # Get the current namespace for the session
    namespace = {}
    if manager.has_session(payload.session_id):
        namespace = manager.get_session_state(payload.session_id)
    
    # Get completions from the engine
    completions = engine.get_completions(payload.code, payload.position, namespace)
    
    # Convert to response format
    completion_responses = [
        CompletionItemResponse(
            label=item.label,
            kind=item.kind,
            detail=item.detail,
            documentation=item.documentation,
            insertText=item.insert_text,
        )
        for item in completions
    ]
    
    return AutocompleteResponse(completions=completion_responses)


@router.get("/project-tree", response_model=Dict[str, Any])
def get_project_tree(request: Request) -> Dict[str, Any]:
    """Return a serialized view of the global ProjectTree."""
    tree = _get_project_tree(request)
    return tree.to_dict()


@router.get("/project/save")
def save_project(request: Request) -> Response:
    """Serialize and download the current ProjectTree."""
    tree = _get_project_tree(request)
    try:
        archive = serialize_project_tree(tree)
    except ProjectIOError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return Response(
        content=archive,
        media_type="application/octet-stream",
        headers={"Content-Disposition": 'attachment; filename="project.pdz"'},
    )


@router.post("/project/load", response_model=ProjectLoadResponse)
async def load_project(request: Request, file: UploadFile = File(...)) -> ProjectLoadResponse:
    """Load a ProjectTree archive into the global tree."""
    tree = _get_project_tree(request)
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty project archive")
    try:
        load_project_tree(data, target=tree)
    except ProjectIOError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ProjectLoadResponse(status="ok", root_keys=list(tree.keys()))
