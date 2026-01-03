# Backend API (PR #2)

This document describes the lightweight backend API introduced in PR #2. The API is served by the FastAPI application defined in `src/platform/server/app.py`.

## Endpoints

### `POST /sessions`
Create a session for stateful command execution.

**Request Body**
```json
{
  "session_id": "optional-custom-id"
}
```

**Response**
```json
{ "session_id": "generated-or-provided-id" }
```

### `POST /execute`
Execute Python code in an isolated subprocess scoped to a session.

**Request Body**
```json
{
  "code": "x = 2\nprint(x)",
  "session_id": "existing-session-id (optional)",
  "timeout": 5.0
}
```

**Response**
```json
{
  "session_id": "resolved-session-id",
  "stdout": "2\n",
  "stderr": "",
  "state": { "x": 2 },
  "error": null
}
```

### `GET /state/{session_id}`
Return the stored state for a session. Returns `404` if the session is unknown.

**Response**
```json
{ "x": 2 }
```

## Behavior

- Sessions are managed by `StateManager` and persist across executions.
- Code executes inside a subprocess (`SubprocessExecutor`) and returns structured stdout/stderr, updated state, and error information without crashing the server.
- Startup/shutdown hooks are registered in `app.py` to ensure clean lifecycle handling.
