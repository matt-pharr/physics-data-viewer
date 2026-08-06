"""
pdv-python/tests/test_mpl_config.py — Unit tests for pdv.mpl_config.

Everything display- or toolkit-shaped is driven through the module's seams
(``_tcp_connect_ok``, ``_unix_socket_ok``, ``_module_available``,
``_run_subprocess``, ``_platform``), so no X server, Qt binding, or tkinter
is required — the suite passes on a bare install and on any CI platform.
The two real-subprocess smoke tests use only the stdlib.

Reference: pdv/mpl_config.py module docstring; issue #369.
"""

import os
import sys
from unittest.mock import MagicMock

import pytest

import pdv.mpl_config as mpl_config


@pytest.fixture(autouse=True)
def _reset_mpl_config_state():
    """Isolate module-level state and env vars the code under test mutates.

    ``configure()``/``check_gui_allowed()`` may set ``QT_API`` (deliberate
    steering), and verdicts are cached in ``_preflight_cache`` — both must
    not leak between tests. An *ambient* ``QT_API`` (common in conda Qt
    setups) is popped for the test's duration so verdicts don't depend on
    the developer's shell. ``plt.show`` wrappers (the Agg shim and the
    first-show notice) are unwound so they can't leak across tests either.
    """
    saved_qt_api = os.environ.pop("QT_API", None)
    saved_display = os.environ.get("DISPLAY")
    yield
    mpl_config._preflight_cache.clear()
    mpl_config.decision = None
    mpl_config.decision_reason = None
    mpl_config._qt_api_set_by_pdv = False
    import matplotlib.pyplot as plt

    while getattr(plt.show, "_pdv_original_show", None) is not None:
        plt.show = plt.show._pdv_original_show
    for name, saved in (("QT_API", saved_qt_api), ("DISPLAY", saved_display)):
        if saved is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = saved


def _forbid(monkeypatch, name):
    """Replace seam ``name`` with a function that fails the test if called."""

    def _boom(*args, **kwargs):
        raise AssertionError(f"{name} must not be called on this path")

    monkeypatch.setattr(mpl_config, name, _boom)


class TestParseDisplay:
    """parse_display maps $DISPLAY forms to probe targets."""

    @pytest.mark.parametrize(
        ("display", "expected"),
        [
            (
                ":0",
                [("unix", "/tmp/.X11-unix/X0"), ("tcp", "127.0.0.1", 6000)],
            ),
            (
                ":1.0",
                [("unix", "/tmp/.X11-unix/X1"), ("tcp", "127.0.0.1", 6001)],
            ),
            ("localhost:10.0", [("tcp", "127.0.0.1", 6010)]),
            ("127.0.0.1:11", [("tcp", "127.0.0.1", 6011)]),
            ("feyn:2", [("tcp", "feyn", 6002)]),
            (" localhost:10 ", [("tcp", "127.0.0.1", 6010)]),
        ],
    )
    def test_recognized_forms(self, display, expected):
        assert mpl_config.parse_display(display) == expected

    @pytest.mark.parametrize(
        "display",
        ["unix:/tmp/x", "wayland-0", "", "localhost:abc", "host:1:2"],
    )
    def test_unrecognized_forms_return_none(self, display):
        """Unknown transports must parse to None (= assume live)."""
        assert mpl_config.parse_display(display) is None


class TestDisplayIsLive:
    """display_is_live probes parsed targets through the socket seams."""

    def test_tcp_alive(self, monkeypatch):
        monkeypatch.setattr(mpl_config, "_tcp_connect_ok", lambda *a: True)
        assert mpl_config.display_is_live("localhost:10.0") is True

    def test_tcp_dead(self, monkeypatch):
        monkeypatch.setattr(mpl_config, "_tcp_connect_ok", lambda *a: False)
        assert mpl_config.display_is_live("localhost:10.0") is False

    def test_local_display_unix_hit_short_circuits_tcp(self, monkeypatch):
        """':0' probes the unix socket first; TCP is not consulted on a hit."""
        monkeypatch.setattr(mpl_config, "_unix_socket_ok", lambda *a: True)
        _forbid(monkeypatch, "_tcp_connect_ok")
        assert mpl_config.display_is_live(":0") is True

    def test_local_display_falls_back_to_tcp(self, monkeypatch):
        monkeypatch.setattr(mpl_config, "_unix_socket_ok", lambda *a: False)
        monkeypatch.setattr(mpl_config, "_tcp_connect_ok", lambda *a: True)
        assert mpl_config.display_is_live(":0") is True

    def test_unrecognized_form_assumed_live(self, monkeypatch):
        """A parser gap must never block a working exotic setup."""
        _forbid(monkeypatch, "_tcp_connect_ok")
        _forbid(monkeypatch, "_unix_socket_ok")
        assert mpl_config.display_is_live("wayland-0") is True


class TestPreflight:
    """preflight_gui verdicts, caching, and the real-subprocess runner."""

    def test_pass_verdict(self, monkeypatch):
        monkeypatch.setattr(
            mpl_config, "_module_available", lambda name: name == "PyQt5"
        )
        monkeypatch.setattr(mpl_config, "_run_subprocess", lambda c, t: (True, ""))
        assert mpl_config.preflight_gui("qt") == (True, "")

    def test_signal_death_reason_names_binding_and_display(self, monkeypatch):
        monkeypatch.setenv("DISPLAY", "localhost:10.0")
        monkeypatch.setattr(
            mpl_config, "_module_available", lambda name: name == "PyQt6"
        )
        monkeypatch.setattr(
            mpl_config, "_run_subprocess", lambda c, t: (False, "died with signal 6")
        )
        ok, why = mpl_config.preflight_gui("qt")
        assert ok is False
        assert "PyQt6" in why
        assert "signal 6" in why
        assert "localhost:10.0" in why
        # Only the process-fatal class earns the crash warning.
        assert "kernel would have crashed" in why

    def test_no_binding_installed(self, monkeypatch):
        monkeypatch.delenv("QT_API", raising=False)
        monkeypatch.setattr(mpl_config, "_module_available", lambda name: False)
        _forbid(monkeypatch, "_run_subprocess")
        ok, why = mpl_config.preflight_gui("qt")
        assert ok is False
        assert "no Qt binding" in why
        assert "pdv.install" in why  # actionable, not "fix the display"

    def test_verdict_cached_per_env(self, monkeypatch):
        calls = []
        monkeypatch.setenv("DISPLAY", "localhost:10.0")
        monkeypatch.setattr(mpl_config, "_module_available", lambda name: True)
        monkeypatch.setattr(
            mpl_config,
            "_run_subprocess",
            lambda c, t: calls.append(c) or (True, ""),
        )
        mpl_config.preflight_gui("tk")
        mpl_config.preflight_gui("tk")
        assert len(calls) == 1
        # Changing DISPLAY invalidates the cached verdict.
        monkeypatch.setenv("DISPLAY", "localhost:11.0")
        mpl_config.preflight_gui("tk")
        assert len(calls) == 2

    def test_run_subprocess_smoke_ok(self):
        """Real subprocess: clean exit classifies as pass (stdlib only)."""
        assert mpl_config._run_subprocess("raise SystemExit(0)", 30.0) == (True, "")

    @pytest.mark.skipif(
        sys.platform == "win32",
        reason="Windows reports signal deaths as positive exit codes",
    )
    def test_run_subprocess_smoke_sigabrt(self):
        """Real subprocess: SIGABRT (the Qt xcb death) stays in the child."""
        ok, why = mpl_config._run_subprocess(
            "import os, signal; os.kill(os.getpid(), signal.SIGABRT)", 30.0
        )
        assert ok is False
        assert "signal" in why

    def test_run_subprocess_hang_is_killed(self):
        """Real subprocess: a hang is bounded by the timeout (and the call
        itself returns promptly — an orphaned child would blow the bound)."""
        import time

        start = time.monotonic()
        ok, why = mpl_config._run_subprocess("import time; time.sleep(30)", 0.5)
        elapsed = time.monotonic() - start
        assert ok is False
        assert "did not finish" in why
        assert elapsed < 5.0


class TestChooseQtBinding:
    """QT_API steering picks PyQt5 first and respects an existing choice."""

    def test_prefers_pyqt5_when_both_present(self, monkeypatch):
        monkeypatch.delenv("QT_API", raising=False)
        monkeypatch.setattr(
            mpl_config,
            "_module_available",
            lambda name: name in ("PyQt5", "PyQt6"),
        )
        assert mpl_config._choose_qt_binding("qt") == ("pyqt5", "PyQt5")

    def test_respects_existing_qt_api(self, monkeypatch):
        monkeypatch.setenv("QT_API", "pyqt6")
        monkeypatch.setattr(
            mpl_config,
            "_module_available",
            lambda name: name in ("PyQt5", "PyQt6"),
        )
        assert mpl_config._choose_qt_binding("qt") == ("pyqt6", "PyQt6")

    def test_set_but_uninstalled_qt_api_reports_unavailable(self, monkeypatch):
        """A user's explicit QT_API is never silently overridden."""
        monkeypatch.setenv("QT_API", "pyside6")
        monkeypatch.setattr(
            mpl_config, "_module_available", lambda name: name == "PyQt5"
        )
        assert mpl_config._choose_qt_binding("qt") is None


class _FakeEvents:
    """Minimal IPython events double: register/unregister + manual firing."""

    def __init__(self):
        self.registered = []

    def register(self, name, fn):
        self.registered.append((name, fn))

    def unregister(self, name, fn):
        self.registered.remove((name, fn))

    def fire(self, name):
        for event, fn in list(self.registered):
            if event == name:
                fn()


class _FakeShell:
    """Minimal shell double: enable_matplotlib records calls.

    A plain class (not MagicMock) so ``pylab_gui_select`` and attribute
    semantics behave like a real InteractiveShell — including the one-shot
    gui-select latch that IPython sets on a successful GUI enable (the
    semantics behind the ``_clear_gui_select`` fix).
    """

    def __init__(self, side_effects=None):
        self.calls = []
        self.pylab_gui_select = None
        self._side_effects = list(side_effects or [])
        self.events = _FakeEvents()

    def enable_matplotlib(self, gui=None):
        self.calls.append(gui)
        if self._side_effects:
            effect = self._side_effects.pop(0)
            if isinstance(effect, Exception):
                raise effect
        # Mimic IPython: a successful *GUI* enable latches the one-shot
        # toolkit selection ("inline" resolves to gui=None and does not).
        if gui is not None and gui != "inline" and self.pylab_gui_select is None:
            self.pylab_gui_select = gui
        return (gui, "backend")


@pytest.fixture()
def linux(monkeypatch):
    """Force the Linux decision path with a clean display env."""
    monkeypatch.setattr(mpl_config, "_platform", lambda: "linux")
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    monkeypatch.delenv("QT_API", raising=False)
    monkeypatch.setattr(mpl_config, "_user_configured_backend", lambda: None)


class TestConfigureLinux:
    """configure() decision flow on (forced) Linux."""

    def test_no_display_goes_inline_with_zero_probe_cost(
        self, linux, monkeypatch, capsys
    ):
        """No DISPLAY: inline immediately, no sockets, no subprocesses."""
        _forbid(monkeypatch, "_run_subprocess")
        _forbid(monkeypatch, "_tcp_connect_ok")
        _forbid(monkeypatch, "_unix_socket_ok")
        ip = _FakeShell()
        mpl_config.configure(ip)
        assert ip.calls == ["inline"]
        assert mpl_config.decision == "inline"
        assert "no DISPLAY" in capsys.readouterr().out

    def test_dead_display_goes_inline_with_message(self, linux, monkeypatch, capsys):
        monkeypatch.setenv("DISPLAY", "localhost:10.0")
        monkeypatch.setattr(mpl_config, "_tcp_connect_ok", lambda *a: False)
        _forbid(monkeypatch, "_run_subprocess")
        ip = _FakeShell()
        mpl_config.configure(ip)
        assert ip.calls == ["inline"]
        out = capsys.readouterr().out
        assert "localhost:10.0" in out
        assert "no longer reachable" in out
        # The boot-tail print is invisible to the user; the reason must be
        # re-armed to print on the first plt.show().
        import matplotlib.pyplot as plt

        assert getattr(plt.show, "_pdv_inline_notice", False) is True

    def _live_qt(self, monkeypatch):
        monkeypatch.setenv("DISPLAY", "localhost:10.0")
        monkeypatch.setattr(mpl_config, "_tcp_connect_ok", lambda *a: True)
        monkeypatch.setattr(
            mpl_config, "_module_available", lambda name: name == "PyQt5"
        )
        monkeypatch.setattr(mpl_config, "_run_subprocess", lambda c, t: (True, ""))

    def test_live_display_defers_qt_until_first_execution(
        self, linux, monkeypatch
    ):
        """Handshake runs on inline; qt arms one-shot on pre_execute.

        A GUI event loop started mid-handshake starved pdv.init on CI
        (loop_tk under Xvfb) — the enable must never run during bootstrap.
        """
        self._live_qt(monkeypatch)
        ip = _FakeShell()
        mpl_config.configure(ip)
        assert ip.calls == ["inline"]
        assert mpl_config.decision == "qt-deferred"
        assert os.environ["QT_API"] == "pyqt5"
        assert [name for name, _ in ip.events.registered] == ["pre_execute"]
        # First execution: the hook enables qt, unregisters itself, and
        # releases the one-shot gui selection for the user.
        ip.events.fire("pre_execute")
        assert ip.calls == ["inline", "qt"]
        assert mpl_config.decision == "qt"
        assert ip.pylab_gui_select is None
        assert ip.events.registered == []
        # Second execution: strictly one-shot.
        ip.events.fire("pre_execute")
        assert ip.calls == ["inline", "qt"]

    def test_deferred_qt_refused_if_display_died_before_first_cell(
        self, linux, monkeypatch, capsys
    ):
        """The hook re-checks: a display that died in the gap refuses
        visibly (into the first cell's output) and inline stays active."""
        self._live_qt(monkeypatch)
        alive = {"value": True}
        monkeypatch.setattr(
            mpl_config, "_tcp_connect_ok", lambda *a: alive["value"]
        )
        ip = _FakeShell()
        mpl_config.configure(ip)
        assert mpl_config.decision == "qt-deferred"
        alive["value"] = False
        ip.events.fire("pre_execute")
        assert ip.calls == ["inline"]  # qt never enabled
        assert mpl_config.decision == "inline"
        assert "no longer reachable" in capsys.readouterr().out

    def test_deferred_qt_enable_failure_leaves_inline_working(
        self, linux, monkeypatch
    ):
        """orig enable blowing up in the hook must not break execution."""
        self._live_qt(monkeypatch)
        ip = _FakeShell(side_effects=[None, RuntimeError("no qtagg")])
        mpl_config.configure(ip)  # side effect 1: enable("inline") ok
        ip.events.fire("pre_execute")  # side effect 2: enable("qt") raises
        assert ip.calls == ["inline", "qt"]
        assert mpl_config.decision == "inline"

    def test_live_display_without_qt_binding_boots_inline_silently(
        self, linux, monkeypatch
    ):
        """No Qt binding: plain inline, zero subprocesses, no hook."""
        monkeypatch.setenv("DISPLAY", ":0")
        monkeypatch.setattr(mpl_config, "_unix_socket_ok", lambda *a: True)
        monkeypatch.setattr(mpl_config, "_module_available", lambda name: False)
        _forbid(monkeypatch, "_run_subprocess")
        ip = _FakeShell()
        mpl_config.configure(ip)
        assert ip.calls == ["inline"]
        assert mpl_config.decision == "inline"
        assert mpl_config.decision_reason is None
        assert "QT_API" not in os.environ
        assert ip.events.registered == []

    def test_live_display_qt_preflight_failure_falls_back_with_reason(
        self, linux, monkeypatch
    ):
        """A binding that fails pre-flight boots inline with the reason
        armed for the first plt.show()."""
        monkeypatch.setenv("DISPLAY", "localhost:10.0")
        monkeypatch.setattr(mpl_config, "_tcp_connect_ok", lambda *a: True)
        monkeypatch.setattr(
            mpl_config, "_module_available", lambda name: name == "PyQt6"
        )
        monkeypatch.setattr(
            mpl_config, "_run_subprocess", lambda c, t: (False, "died with signal 6")
        )
        ip = _FakeShell()
        mpl_config.configure(ip)
        assert ip.calls == ["inline"]
        assert mpl_config.decision == "inline"
        assert "PyQt6" in (mpl_config.decision_reason or "")
        assert ip.events.registered == []


class TestConfigureOtherPlatforms:
    """configure() on darwin/windows and the degenerate paths."""

    def test_darwin_enables_osx_without_probing(self, monkeypatch):
        monkeypatch.setattr(mpl_config, "_platform", lambda: "darwin")
        monkeypatch.setattr(mpl_config, "_user_configured_backend", lambda: None)
        _forbid(monkeypatch, "_run_subprocess")
        _forbid(monkeypatch, "_tcp_connect_ok")
        ip = _FakeShell()
        mpl_config.configure(ip)
        assert ip.calls == ["osx"]
        assert mpl_config.decision == "osx"
        assert ip.pylab_gui_select is None

    def test_darwin_osx_failure_falls_back_to_tk(self, monkeypatch):
        monkeypatch.setattr(mpl_config, "_platform", lambda: "darwin")
        monkeypatch.setattr(mpl_config, "_user_configured_backend", lambda: None)
        ip = _FakeShell(side_effects=[RuntimeError("not a framework build")])
        mpl_config.configure(ip)
        assert ip.calls == ["osx", "tk"]
        assert mpl_config.decision == "tk"

    def test_configured_backend_enabled_with_event_loop_when_safe(self, monkeypatch):
        """MPLBACKEND=qtagg on a healthy display: honored THROUGH enable()."""
        monkeypatch.setattr(mpl_config, "_platform", lambda: "linux")
        monkeypatch.setenv("DISPLAY", "localhost:10.0")
        monkeypatch.setattr(mpl_config, "_tcp_connect_ok", lambda *a: True)
        monkeypatch.setattr(
            mpl_config, "_module_available", lambda name: name == "PyQt5"
        )
        monkeypatch.setattr(mpl_config, "_run_subprocess", lambda c, t: (True, ""))
        monkeypatch.setattr(mpl_config, "_current_backend_name", lambda: "qtagg")
        ip = _FakeShell()
        mpl_config.configure(ip)
        # Enabled through enable_matplotlib so the event loop is installed —
        # a bare return here reproduced the frozen-window bug for
        # MPLBACKEND users.
        assert ip.calls == ["qtagg"]
        assert mpl_config.decision == "user"
        assert ip.pylab_gui_select is None
        assert getattr(ip.enable_matplotlib, "_pdv_guarded", False) is True

    def test_configured_backend_refused_on_dead_display(self, monkeypatch, capsys):
        """MPLBACKEND=qtagg + stale DISPLAY: the kernel must NOT die."""
        monkeypatch.setattr(mpl_config, "_platform", lambda: "linux")
        monkeypatch.setenv("DISPLAY", "localhost:10.0")
        monkeypatch.setattr(mpl_config, "_tcp_connect_ok", lambda *a: False)
        monkeypatch.setattr(mpl_config, "_current_backend_name", lambda: "qtagg")
        _forbid(monkeypatch, "_run_subprocess")
        ip = _FakeShell()
        mpl_config.configure(ip)
        assert ip.calls == ["inline"]
        assert mpl_config.decision == "inline"
        out = capsys.readouterr().out
        assert "configured backend qtagg was refused" in out

    def test_no_shell_installs_agg_shim(self, monkeypatch):
        """ip=None: parity with historical plain-python behavior."""
        import matplotlib
        import matplotlib.pyplot as plt

        monkeypatch.setattr(plt, "show", plt.show)  # auto-restore
        mpl_config.configure(None)
        assert matplotlib.get_backend().lower() == "agg"
        assert getattr(plt.show, "_pdv_inline_shim", False) is True


class TestEnableMatplotlibGuard:
    """The %matplotlib crash guard."""

    def test_refusal_prints_and_returns_tuple(self, monkeypatch, capsys):
        """The magic unpacks the return value — shape is contractual."""
        monkeypatch.setattr(mpl_config, "_platform", lambda: "linux")
        monkeypatch.delenv("DISPLAY", raising=False)
        monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
        ip = _FakeShell()
        mpl_config._install_enable_matplotlib_guard(ip)
        result = ip.enable_matplotlib("qt")
        assert ip.calls == []  # original never invoked
        assert isinstance(result, tuple) and len(result) == 2
        assert result[0] == "inline"
        assert isinstance(result[1], str)
        out = capsys.readouterr().out
        assert "refusing %matplotlib qt" in out
        assert "no display for native windows" in out
        # Command-free advice: PDV users never type ssh commands.
        assert "ssh -X" not in out

    def test_allowed_gui_passes_through(self, monkeypatch):
        monkeypatch.setattr(mpl_config, "_platform", lambda: "linux")
        ip = _FakeShell()
        mpl_config._install_enable_matplotlib_guard(ip)
        ip.enable_matplotlib("inline")
        assert ip.calls == ["inline"]

    def test_non_linux_always_passes_through(self, monkeypatch):
        monkeypatch.setattr(mpl_config, "_platform", lambda: "darwin")
        _forbid(monkeypatch, "_run_subprocess")
        ip = _FakeShell()
        mpl_config._install_enable_matplotlib_guard(ip)
        ip.enable_matplotlib("qt")
        assert ip.calls == ["qt"]

    def test_install_is_idempotent(self):
        ip = _FakeShell()
        mpl_config._install_enable_matplotlib_guard(ip)
        guarded = ip.enable_matplotlib
        mpl_config._install_enable_matplotlib_guard(ip)
        assert ip.enable_matplotlib is guarded

    def test_retry_after_display_fix_succeeds(self, monkeypatch):
        """A refusal must not poison a later attempt on a healthy display."""
        monkeypatch.setattr(mpl_config, "_platform", lambda: "linux")
        monkeypatch.setenv("DISPLAY", "localhost:10.0")
        monkeypatch.setattr(mpl_config, "_module_available", lambda name: True)
        alive = {"value": False}
        monkeypatch.setattr(
            mpl_config, "_tcp_connect_ok", lambda *a: alive["value"]
        )
        monkeypatch.setattr(mpl_config, "_run_subprocess", lambda c, t: (True, ""))
        ip = _FakeShell()
        mpl_config._install_enable_matplotlib_guard(ip)
        ip.enable_matplotlib("qt")
        assert ip.calls == []
        alive["value"] = True
        ip.enable_matplotlib("qt")
        assert ip.calls == ["qt"]

    def test_unknown_gui_name_passes_through(self, monkeypatch):
        """Unknown spellings get IPython's normal error, not a PDV refusal."""
        monkeypatch.setattr(mpl_config, "_platform", lambda: "linux")
        monkeypatch.delenv("DISPLAY", raising=False)
        ip = _FakeShell()
        mpl_config._install_enable_matplotlib_guard(ip)
        ip.enable_matplotlib("not-a-real-gui")
        assert ip.calls == ["not-a-real-gui"]

    def test_bootstrap_installs_guard_on_mock_shell(self, monkeypatch):
        """configure() wires the guard onto whatever shell bootstrap has."""
        monkeypatch.setattr(mpl_config, "_platform", lambda: "darwin")
        monkeypatch.setattr(mpl_config, "_user_configured_backend", lambda: None)
        ip = MagicMock()
        mpl_config.configure(ip)
        assert getattr(ip.enable_matplotlib, "_pdv_guarded", False) is True


class TestInlineShim:
    """The legacy Agg plt.show() shim."""

    def test_patch_is_idempotent(self, monkeypatch, capsys):
        import matplotlib.pyplot as plt

        # Pin to a plain function first: an earlier test module may have
        # left the (idempotent) shim installed globally.
        monkeypatch.setattr(plt, "show", lambda *a, **k: None)
        mpl_config._patch_plt_show_for_inline_capture()
        patched = plt.show
        assert getattr(patched, "_pdv_inline_shim", False) is True
        mpl_config._patch_plt_show_for_inline_capture()
        assert plt.show is patched
        # The install notice prints once, not twice.
        out = capsys.readouterr().out
        assert out.count("No interactive matplotlib backend") == 1

    def test_inline_fallback_degrades_to_shim_when_inline_fails(
        self, monkeypatch, capsys
    ):
        import matplotlib.pyplot as plt

        monkeypatch.setattr(plt, "show", lambda *a, **k: None)

        def _broken_enable(gui):
            raise RuntimeError("no matplotlib_inline")

        mpl_config._fallback_inline(_broken_enable, "test reason")
        # Stack: first-show notice wrapper over the Agg shim.
        assert getattr(plt.show, "_pdv_inline_notice", False) is True
        assert getattr(plt.show._pdv_original_show, "_pdv_inline_shim", False) is True
        assert "test reason" in capsys.readouterr().out


class TestQtApiSteering:
    """PDV-authored QT_API can be re-steered; user-authored cannot."""

    def _live_qt_env(self, monkeypatch, bindings):
        monkeypatch.setattr(mpl_config, "_platform", lambda: "linux")
        monkeypatch.setenv("DISPLAY", "localhost:10.0")
        monkeypatch.setattr(mpl_config, "_tcp_connect_ok", lambda *a: True)
        monkeypatch.setattr(
            mpl_config, "_module_available", lambda name: name in bindings
        )
        monkeypatch.setattr(mpl_config, "_run_subprocess", lambda c, t: (True, ""))

    def test_pdv_steering_resteers_for_explicit_qt6(self, monkeypatch):
        """%matplotlib qt6 after PDV picked pyqt5 must not be poisoned."""
        self._live_qt_env(monkeypatch, ("PyQt5", "PyQt6"))
        ip = _FakeShell()
        mpl_config._install_enable_matplotlib_guard(ip)
        ip.enable_matplotlib("qt")
        assert os.environ["QT_API"] == "pyqt5"  # PDV's steering
        ip.enable_matplotlib("qt6")
        assert os.environ["QT_API"] == "pyqt6"  # re-steered, not refused
        assert ip.calls == ["qt", "qt6"]

    def test_user_qt_api_never_overridden_and_message_is_accurate(
        self, monkeypatch, capsys
    ):
        """A user-exported QT_API that can't serve qt6 refuses accurately."""
        self._live_qt_env(monkeypatch, ("PyQt5", "PyQt6"))
        monkeypatch.setenv("QT_API", "pyqt5")  # user-authored (flag is False)
        ip = _FakeShell()
        mpl_config._install_enable_matplotlib_guard(ip)
        ip.enable_matplotlib("qt6")
        assert ip.calls == []
        assert os.environ["QT_API"] == "pyqt5"  # untouched
        out = capsys.readouterr().out
        assert "QT_API=pyqt5" in out
        assert "no Qt binding is installed" not in out  # the old false message


class TestGuardCoverage:
    """Family coverage of the %matplotlib guard."""

    def test_wx_is_guarded_on_probe_platforms(self, monkeypatch, capsys):
        monkeypatch.setattr(mpl_config, "_platform", lambda: "linux")
        monkeypatch.delenv("DISPLAY", raising=False)
        monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
        ip = _FakeShell()
        mpl_config._install_enable_matplotlib_guard(ip)
        ip.enable_matplotlib("wx")
        assert ip.calls == []
        assert "refusing %matplotlib wx" in capsys.readouterr().out


class TestInlineNotice:
    """The deferred 'why are my plots inline' notice (first plt.show())."""

    def test_notice_prints_once_then_unwraps(self, monkeypatch, capsys):
        import matplotlib.pyplot as plt

        monkeypatch.setattr(plt, "show", lambda *a, **k: None)
        mpl_config._arm_inline_notice("test reason")
        plt.show()
        assert capsys.readouterr().out.count("test reason") == 1
        plt.show()
        assert "test reason" not in capsys.readouterr().out

    def test_disarm_removes_pending_notice(self, monkeypatch, capsys):
        import matplotlib.pyplot as plt

        def base(*args, **kwargs):
            return None

        monkeypatch.setattr(plt, "show", base)
        mpl_config._arm_inline_notice("test reason")
        mpl_config._disarm_inline_notice()
        assert plt.show is base
        plt.show()
        assert "test reason" not in capsys.readouterr().out

    def test_sanctioned_gui_switch_disarms_notice(self, monkeypatch):
        """A successful %matplotlib switch supersedes the inline state."""
        import matplotlib.pyplot as plt

        def base(*args, **kwargs):
            return None

        monkeypatch.setattr(plt, "show", base)
        monkeypatch.setattr(mpl_config, "_platform", lambda: "darwin")
        mpl_config._arm_inline_notice("test reason")
        ip = _FakeShell()
        mpl_config._install_enable_matplotlib_guard(ip)
        ip.enable_matplotlib("osx")
        assert ip.calls == ["osx"]
        assert plt.show is base  # notice disarmed by the allowed switch


class TestCurrentBackendName:
    """_current_backend_name against the real installed matplotlib."""

    def test_returns_str_or_none_without_resolving(self):
        """Pins the get_backend(auto_select=False) API across the CI
        matplotlib matrix — the single most version-sensitive call here."""
        result = mpl_config._current_backend_name()
        assert result is None or isinstance(result, str)


class TestDisplaySeam:
    """The PDV_MPL_DISPLAY test seam (e2e harnesses on Linux)."""

    def test_override_wins_over_real_display(self, monkeypatch):
        monkeypatch.setenv("DISPLAY", ":0")  # the app's real (live) display
        monkeypatch.setenv("PDV_MPL_DISPLAY", "localhost:99.0")
        monkeypatch.setattr(mpl_config, "_tcp_connect_ok", lambda *a: False)
        assert mpl_config._display_gate() == ("dead", "localhost:99.0")

    def test_empty_override_means_unset(self, monkeypatch):
        monkeypatch.setenv("DISPLAY", ":0")
        monkeypatch.setenv("PDV_MPL_DISPLAY", "")
        monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
        assert mpl_config._display_gate() == ("none", None)

    def test_absent_override_falls_through(self, monkeypatch):
        monkeypatch.delenv("PDV_MPL_DISPLAY", raising=False)
        monkeypatch.setenv("DISPLAY", "localhost:10.0")
        monkeypatch.setattr(mpl_config, "_tcp_connect_ok", lambda *a: True)
        assert mpl_config._display_gate() == ("live", "localhost:10.0")
