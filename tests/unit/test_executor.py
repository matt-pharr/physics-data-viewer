import pytest

from platform.server.executor import ExecutionError, SubprocessExecutor
from platform.server.state import StateManager


def test_execute_updates_state_and_output():
    state = StateManager()
    executor = SubprocessExecutor(state)
    session = state.create_session("session-a")

    result = executor.execute("x = 2\nprint(x * 2)", session_id=session)

    assert result.success
    assert "4" in result.stdout
    stored_state = state.get_session_state(session)
    assert stored_state["x"] == 2


def test_execute_is_isolated_between_sessions():
    state = StateManager()
    executor = SubprocessExecutor(state)
    session_one = state.create_session("one")
    session_two = state.create_session("two")

    executor.execute("value = 1", session_id=session_one)
    executor.execute("value = 5", session_id=session_two)

    assert state.get_session_state(session_one)["value"] == 1
    assert state.get_session_state(session_two)["value"] == 5


def test_execute_returns_error_information():
    state = StateManager()
    executor = SubprocessExecutor(state)
    session = state.create_session("error-session")

    result = executor.execute("raise ValueError('boom')", session_id=session)

    assert result.error is not None
    assert "ValueError" in result.error
    assert "ValueError" in result.stderr


def test_execute_rejects_empty_code():
    state = StateManager()
    executor = SubprocessExecutor(state)
    session = state.create_session("empty")

    with pytest.raises(ExecutionError):
        executor.execute("", session_id=session)
