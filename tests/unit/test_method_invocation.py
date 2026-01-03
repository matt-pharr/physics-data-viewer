from platform.server.method_executor import MethodExecutor
from platform.server.state import StateManager


class MultiResult:
    def show(self) -> str:
        return "text-result"

    def plot(self):
        return {"points": [(0, 1)]}

    def image(self) -> bytes:
        return b"binary-image"

    def fail(self):
        raise RuntimeError("invocation failed")


def test_method_executor_classifies_results_and_errors():
    state = StateManager()
    session = state.create_session("session-1")
    payload = MultiResult()
    state.set_nested(session, ["root", "payload"], payload)

    executor = MethodExecutor(state)

    show_result = executor.invoke(session, ["root", "payload"], "show")
    assert show_result.succeeded
    assert show_result.result_type == "text"
    assert show_result.result == "text-result"

    plot_result = executor.invoke(session, ["root", "payload"], "plot")
    assert plot_result.result_type == "plot"
    assert plot_result.result == {"points": [(0, 1)]}

    image_result = executor.invoke(session, ["root", "payload"], "image")
    assert image_result.result_type == "image"
    assert image_result.result == b"binary-image"

    error_result = executor.invoke(session, ["root", "payload"], "fail")
    assert not error_result.succeeded
    assert error_result.error is not None
    assert "RuntimeError" in (error_result.traceback or "")
