"""
pdv/mpl_config.py — safe matplotlib backend selection for PDV kernels.

Chooses and enables a matplotlib backend at bootstrap through IPython's
``enable_matplotlib`` machinery (which installs the ipykernel event loop —
without it, GUI windows open frozen or not at all), and guards every
user-invoked ``%matplotlib <gui>`` switch so that a broken display can
never take the kernel down.

Why the caution: Qt's xcb platform plugin calls C-level ``abort()`` when it
cannot connect to the X server — an uncatchable SIGABRT that kills the whole
kernel process. On a remote host the kernel daemon outlives the ssh channel
that set its ``$DISPLAY``, so a stale-but-set display is the *common* case,
not an edge case. Three layers of defense:

1. **Display probe + deferred enable on probe platforms** (i.e. not
   macOS/Windows): ``$DISPLAY`` unset or dead (cheap socket probe; ssh
   forwards ``localhost:N`` as TCP port ``6000+N``) → inline. Live display
   with a Qt binding → plots default to native windows, but the event
   loop is enabled one-shot just before the user's FIRST execution, never
   mid-handshake — a GUI event loop started during bootstrap can starve
   the session handshake even after a green pre-flight (observed:
   ipykernel's ``loop_tk`` under Xvfb starving ``pdv.init``). Qt is the
   only auto candidate (the one with field mileage); tk/gtk are opt-in
   via the guarded ``%matplotlib``.
2. **Subprocess pre-flight**: before enabling any GUI backend, a throwaway
   ``python -c`` child imports the toolkit and connects to the display.
   A SIGABRT lands in the child, not the kernel.
3. **The %matplotlib guard**: ``ip.enable_matplotlib`` is wrapped so
   user-invoked switches run the same checks and print a refusal instead
   of dying.

When both PyQt5 and PyQt6 are installed, ``QT_API`` is steered toward PyQt5:
matplotlib's ``qtagg`` prefers PyQt6, whose xcb plugin is far stricter about
GLX/xcb-cursor under X forwarding (observed kernel death on a *live*
forwarded display). PDV remembers that it authored the steering, so an
explicit ``%matplotlib qt6`` later re-steers to a Qt6 binding; only a
QT_API the *user* exported is treated as their choice.

A backend deliberately configured via ``MPLBACKEND`` is honored — but it
still goes through the same safety checks, and it is enabled through
``enable_matplotlib`` so it gets the event loop. (matplotlibrc alone can
never reach this module pre-configured: ipykernel forces
``MPLBACKEND=module://matplotlib_inline.backend_inline`` when unset before
the shell exists.)

The inline fallback is the real ``matplotlib-inline`` backend (declared as
a direct dependency), whose ``show()`` emits ``display_data`` immediately —
including from comm handlers, so double-click tree plots work unchanged.
Because bootstrap output lands in the handshake's boot tail rather than the
console, the *reason* for an inline fallback is also re-printed once, on
the user's first ``plt.show()``. The legacy Agg + patched-``plt.show()``
shim survives only for the degenerate no-real-shell path.

Out of scope, deliberately: a direct user call to ``matplotlib.use("qtagg")``
followed by figure creation bypasses these guards — arbitrary user code
cannot be protected from a C-level abort without breaking matplotlib
semantics.

Test seams: the ``PDV_MPL_PLATFORM`` environment variable overrides
``sys.platform`` for the decision logic (e.g. ``PDV_MPL_PLATFORM=linux`` on
a macOS dev machine exercises the probe/pre-flight paths against a real
kernel), and ``PDV_MPL_DISPLAY`` overrides what the decision logic treats
as ``$DISPLAY`` (empty string = unset) — needed because an e2e harness on
Linux cannot override the real ``DISPLAY`` without severing the Electron
app's own X connection. Test-only; never set them in production.

See Also
--------
ARCHITECTURE.md §5.3 (bootstrap detail)
"""

from typing import Any

# Timeout for a single TCP/unix-socket display probe (seconds).
_PROBE_TIMEOUT = 0.5

# Timeout for one pre-flight subprocess (seconds). Generous on purpose: a
# real xcb abort fails fast (inside Qt's own connect timeout), while a
# *healthy* toolkit on a cold NFS home can take many seconds just to import
# — a short timeout would misclassify slow-but-fine as broken and silently
# downgrade the backend.
_PREFLIGHT_TIMEOUT = 10.0

# Backends that mean "nothing deliberately configured" — the ambient
# defaults ipykernel/PDV impose, as opposed to a user choice.
_TRIVIAL_BACKENDS = (
    "agg",
    "inline",
    "module://matplotlib_inline.backend_inline",
    "module://ipykernel.pylab.backend_inline",
    "",
)

# GUI names that never open a display connection and are always allowed
# through the %matplotlib guard.
_ALWAYS_ALLOWED = {
    "auto",
    "inline",
    "agg",
    "headless",
    "widget",
    "ipympl",
    "notebook",
    "nbagg",
    "webagg",
    "svg",
    "pdf",
    "ps",
    "template",
}

# %matplotlib gui / backend spellings mapped to the toolkit family we
# pre-flight. Anything not listed (and not in _ALWAYS_ALLOWED) is passed
# through to IPython untouched, which will raise a normal catchable error
# for unknown names.
_GUI_FAMILIES = {
    "qt": "qt",
    "qtagg": "qt",
    "qtcairo": "qt",
    "qt5": "qt5",
    "qt5agg": "qt5",
    "qt5cairo": "qt5",
    "qt6": "qt6",
    "qt6agg": "qt6",
    "qt6cairo": "qt6",
    "tk": "tk",
    "tkagg": "tk",
    "tkcairo": "tk",
    "gtk3": "gtk3",
    "gtk3agg": "gtk3",
    "gtk3cairo": "gtk3",
    "gtk4": "gtk4",
    "gtk4agg": "gtk4",
    "gtk4cairo": "gtk4",
    "wx": "wx",
    "wxagg": "wx",
    "wxcairo": "wx",
}

# QT_API value -> importable binding package, in PDV preference order.
# PyQt5 first: see module docstring.
_QT_BINDINGS = (
    ("pyqt5", "PyQt5"),
    ("pyqt6", "PyQt6"),
    ("pyside6", "PySide6"),
    ("pyside2", "PySide2"),
)

# Pre-flight verdicts, keyed by (family, QT_API, DISPLAY) so that changing
# either env var (e.g. `%env DISPLAY=localhost:11.0`) invalidates a cached
# refusal. Values are (ok, reason).
_preflight_cache: dict[tuple[str, str | None, str | None], tuple[bool, str]] = {}

# True when the QT_API currently in os.environ was written by PDV's own
# steering rather than exported by the user. PDV-authored values may be
# re-steered (e.g. `%matplotlib qt6` after PDV picked pyqt5); user-authored
# values are never overridden.
_qt_api_set_by_pdv: bool = False

# What configure() decided, for introspection and debugging:
# a gui name, "inline", "user" (pre-configured backend honored), or None
# if configure() has not run.
decision: str | None = None
decision_reason: str | None = None


def _platform() -> str:
    """Return the effective platform for backend decisions.

    Honors the ``PDV_MPL_PLATFORM`` test seam (see module docstring) so the
    probe/pre-flight paths can be exercised on other OSes.

    Returns
    -------
    str
        ``sys.platform``-style identifier (``linux``, ``darwin``, ``win32``).
    """
    import os  # noqa: PLC0415
    import sys  # noqa: PLC0415

    return os.environ.get("PDV_MPL_PLATFORM") or sys.platform


def _is_probe_platform() -> bool:
    """Return True when this platform gets the display probe + pre-flight.

    macOS and Windows GUI backends fail with ordinary catchable exceptions,
    so they skip the machinery; everything else (Linux and other X11-style
    platforms) gets the full treatment. Used by both :func:`configure` and
    :func:`check_gui_allowed` so the two can never disagree.

    Returns
    -------
    bool
        True when probe + pre-flight apply.
    """
    platform = _platform()
    return not (platform == "darwin" or platform.startswith("win"))


def parse_display(display: str) -> list[tuple] | None:
    """Parse an X11 ``DISPLAY`` value into probe targets.

    Parameters
    ----------
    display : str
        The ``$DISPLAY`` value, e.g. ``:0``, ``localhost:10.0``, ``host:2``,
        ``unix:0``.

    Returns
    -------
    list of tuple or None
        Probe targets in preference order — ``("unix", path)`` or
        ``("tcp", host, port)`` — or None when the form is not recognized
        (Wayland-ish or exotic transports), which callers must treat as
        "unknown, assume live" so unusual-but-working setups are not
        blocked on a parser gap.
    """
    import re  # noqa: PLC0415

    match = re.fullmatch(r"(?P<host>[^:]*):(?P<num>\d+)(?:\.\d+)?", display.strip())
    if match is None:
        return None
    host = match.group("host")
    port = 6000 + int(match.group("num"))
    if host in ("", "unix"):
        # Local display (":0" or the explicit "unix:0" spelling): the X
        # server listens on a unix socket; some setups also listen on TCP,
        # so keep that as a fallback probe.
        return [
            ("unix", f"/tmp/.X11-unix/X{match.group('num')}"),
            ("tcp", "127.0.0.1", port),
        ]
    if host in ("localhost", "127.0.0.1", "::1"):
        # The ssh X11-forwarding shape: localhost:N maps to TCP 6000+N.
        return [("tcp", "127.0.0.1", port)]
    return [("tcp", host, port)]


def _tcp_connect_ok(host: str, port: int, timeout: float) -> bool:
    """Return True when a TCP connection to ``host:port`` succeeds.

    Parameters
    ----------
    host : str
        Host to connect to.
    port : int
        TCP port.
    timeout : float
        Connect timeout in seconds.

    Returns
    -------
    bool
        True on successful connect, False on any error.
    """
    import socket  # noqa: PLC0415

    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _unix_socket_ok(path: str, timeout: float) -> bool:
    """Return True when a unix-domain socket at ``path`` accepts connections.

    Parameters
    ----------
    path : str
        Filesystem path of the socket.
    timeout : float
        Connect timeout in seconds.

    Returns
    -------
    bool
        True on successful connect, False on any error (including
        platforms without ``AF_UNIX``).
    """
    import socket  # noqa: PLC0415

    if not hasattr(socket, "AF_UNIX"):
        return False
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(timeout)
            sock.connect(path)
            return True
    except OSError:
        return False


def display_is_live(display: str, *, timeout: float = _PROBE_TIMEOUT) -> bool:
    """Cheaply check whether an X11 display endpoint answers.

    A closed ssh channel leaves ``$DISPLAY`` pointing at a forwarded TCP
    port that nothing listens on anymore — the exact state that makes Qt
    abort the process. This probe costs one connect attempt.

    Parameters
    ----------
    display : str
        The ``$DISPLAY`` value.
    timeout : float
        Per-target connect timeout in seconds.

    Returns
    -------
    bool
        True when any probe target answers, or when the display form is
        unrecognized (assume-live: the pre-flight subprocess is the real
        gate). False when every recognized target refuses.
    """
    targets = parse_display(display)
    if targets is None:
        return True
    for target in targets:
        if target[0] == "unix" and _unix_socket_ok(target[1], timeout):
            return True
        if target[0] == "tcp" and _tcp_connect_ok(target[1], target[2], timeout):
            return True
    return False


def _display_env() -> str | None:
    """Return the ``$DISPLAY`` value the decision logic should use.

    Honors the ``PDV_MPL_DISPLAY`` test seam when present (empty string =
    treat as unset); otherwise the real ``DISPLAY``. See module docstring.

    Returns
    -------
    str or None
        The effective display value, or None when unset.
    """
    import os  # noqa: PLC0415

    if "PDV_MPL_DISPLAY" in os.environ:
        return os.environ["PDV_MPL_DISPLAY"] or None
    return os.environ.get("DISPLAY")


def _display_gate() -> tuple[str, str | None]:
    """Classify the display environment for GUI-backend decisions.

    Returns
    -------
    tuple of (str, str or None)
        ``("none", None)`` when neither ``DISPLAY`` nor ``WAYLAND_DISPLAY``
        is set (empty string counts as unset); ``("dead", display)`` when
        ``DISPLAY`` is set but its endpoint does not answer;
        ``("live", display)`` otherwise (including Wayland-only setups,
        where the pre-flight subprocess is the real gate).
    """
    import os  # noqa: PLC0415

    display = _display_env()
    if not display and not os.environ.get("WAYLAND_DISPLAY"):
        return ("none", None)
    if display and not display_is_live(display):
        return ("dead", display)
    return ("live", display)


def _module_available(name: str) -> bool:
    """Return True when ``name`` is importable, without importing it.

    Parameters
    ----------
    name : str
        Top-level module name (e.g. ``PyQt5``).

    Returns
    -------
    bool
        True when an import spec can be found.
    """
    import importlib.util  # noqa: PLC0415

    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _user_qt_api() -> str:
    """Return the QT_API value the *user* exported, or the empty string.

    A QT_API written by PDV's own steering (:func:`_ensure_qt_api`) does
    not count — treating it as a user choice would permanently lock the
    session to PDV's first pick (e.g. ``%matplotlib qt6`` refused with a
    false "no Qt binding" after PDV steered to pyqt5).

    Returns
    -------
    str
        Lowercased user-authored QT_API, or ``""``.
    """
    import os  # noqa: PLC0415

    if _qt_api_set_by_pdv:
        return ""
    return os.environ.get("QT_API", "").lower()


def _choose_qt_binding(family: str) -> tuple[str, str] | None:
    """Pick the Qt binding to pre-flight and steer matplotlib toward.

    Parameters
    ----------
    family : str
        ``qt`` (any), ``qt5``, or ``qt6``.

    Returns
    -------
    tuple of (str, str) or None
        ``(QT_API value, binding package name)``, or None when no matching
        binding is installed. A *user-exported* ``QT_API`` is respected
        when its binding is installed and compatible with ``family``;
        a PDV-authored one is ignored so explicit family requests can
        re-steer.
    """
    preset = _user_qt_api()
    candidates = {
        "qt": _QT_BINDINGS,
        "qt5": (("pyqt5", "PyQt5"), ("pyside2", "PySide2")),
        "qt6": (("pyqt6", "PyQt6"), ("pyside6", "PySide6")),
    }[family]
    for api, module in candidates:
        if api == preset and _module_available(module):
            return (api, module)
    if preset:
        # A set-but-unusable user QT_API is respected as a *choice* (we
        # won't silently switch bindings under the user), but there is
        # nothing to pre-flight — report unavailable.
        return None
    for api, module in candidates:
        if _module_available(module):
            return (api, module)
    return None


def _ensure_qt_api(family: str) -> None:
    """Steer matplotlib's Qt binding choice via ``QT_API``.

    Must run before matplotlib imports any Qt backend — ``qt_compat`` reads
    ``QT_API`` once at import. A user-exported ``QT_API`` is left alone;
    a PDV-authored one may be re-steered when the requested family changed
    (``%matplotlib qt6`` after PDV picked pyqt5).

    Parameters
    ----------
    family : str
        ``qt``, ``qt5``, or ``qt6``.
    """
    global _qt_api_set_by_pdv  # noqa: PLW0603

    import os  # noqa: PLC0415

    if _user_qt_api():
        return
    chosen = _choose_qt_binding(family)
    if chosen is not None:
        os.environ["QT_API"] = chosen[0]
        _qt_api_set_by_pdv = True


def _preflight_snippet(family: str, qt_module: str | None) -> str:
    """Build the code the pre-flight subprocess runs.

    The snippet imports the toolkit and opens a display connection —
    exactly the operation that can ``abort()`` — then exits 0. The Qt and
    wx snippets exit via ``os._exit`` so toolkit destructors never run: a
    live QApplication at interpreter teardown is a known segfault pattern,
    and a teardown SIGSEGV would be indistinguishable from the xcb abort
    this probe exists to detect.

    Parameters
    ----------
    family : str
        Toolkit family: ``qt``/``qt5``/``qt6``, ``tk``, ``gtk3``/``gtk4``,
        ``wx``.
    qt_module : str or None
        Binding package for qt families (ignored otherwise).

    Returns
    -------
    str
        Python source for ``python -c``.
    """
    if family in ("qt", "qt5", "qt6"):
        return (
            "import importlib; "
            f"W = importlib.import_module('{qt_module}.QtWidgets'); "
            "W.QApplication([]); "
            "import os; os._exit(0)"
        )
    if family == "tk":
        return "import tkinter; r = tkinter.Tk(); r.destroy()"
    if family == "wx":
        return "import wx; wx.App(False); import os; os._exit(0)"
    # gtk3 / gtk4
    version = "4.0" if family == "gtk4" else "3.0"
    return (
        "import gi; "
        f"gi.require_version('Gtk', '{version}'); "
        "from gi.repository import Gtk; "
        "ok = Gtk.init_check(); "
        "ok = ok[0] if isinstance(ok, tuple) else ok; "
        "raise SystemExit(0 if ok else 1)"
    )


def _run_subprocess(code: str, timeout: float) -> tuple[bool, str]:
    """Run ``python -c code`` in a throwaway child and classify the outcome.

    Parameters
    ----------
    code : str
        Python source to execute.
    timeout : float
        Seconds before the child is killed and the run counted as a hang.

    Returns
    -------
    tuple of (bool, str)
        ``(True, "")`` on exit 0; otherwise ``(False, reason)`` where
        reason distinguishes a signal death (SIGABRT = the crash this
        module exists to contain), a hang, and a plain nonzero exit
        (last stderr line included when present).
    """
    import subprocess  # noqa: PLC0415
    import sys  # noqa: PLC0415

    try:
        proc = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return (False, f"did not finish its display check within {timeout:g}s")
    except OSError as exc:
        return (False, f"could not run the check ({exc})")
    if proc.returncode == 0:
        return (True, "")
    if proc.returncode < 0:
        return (False, f"died with signal {-proc.returncode}")
    tail = (proc.stderr or "").strip().splitlines()
    detail = f": {tail[-1]}" if tail else ""
    return (False, f"exited with status {proc.returncode}{detail}")


def preflight_gui(family: str, *, timeout: float = _PREFLIGHT_TIMEOUT) -> tuple[bool, str]:
    """Pre-flight a GUI toolkit in a throwaway subprocess.

    The child inherits the current environment (including any ``QT_API``
    steering applied by :func:`_ensure_qt_api`), so it exercises the same
    binding and display the kernel would.

    Parameters
    ----------
    family : str
        Toolkit family (see ``_GUI_FAMILIES`` values).
    timeout : float
        Subprocess timeout in seconds.

    Returns
    -------
    tuple of (bool, str)
        ``(True, "")`` when the toolkit connected to the display and exited
        cleanly; ``(False, reason)`` otherwise, where the reason names the
        toolkit and, for a missing one, how to install it. Verdicts are
        cached per ``(family, QT_API, DISPLAY)``.
    """
    import os  # noqa: PLC0415

    key = (family, os.environ.get("QT_API"), _display_env())
    cached = _preflight_cache.get(key)
    if cached is not None:
        return cached

    qt_module: str | None = None
    label = family
    if family in ("qt", "qt5", "qt6"):
        chosen = _choose_qt_binding(family)
        if chosen is None:
            user_api = _user_qt_api()
            if user_api:
                why = (
                    f"QT_API={user_api} is set but no matching {family} "
                    "binding is installed"
                )
            else:
                why = (
                    "no Qt binding is installed in this environment — "
                    "install one (e.g. pdv.install('PyQt5')) and retry"
                )
            verdict = (False, why)
            _preflight_cache[key] = verdict
            return verdict
        qt_module = chosen[1]
        label = qt_module
    elif family == "tk":
        if not _module_available("tkinter"):
            verdict = (False, "tkinter is not available in this Python")
            _preflight_cache[key] = verdict
            return verdict
        label = "tkinter"
    elif family == "wx":
        if not _module_available("wx"):
            verdict = (
                False,
                "wxPython is not installed in this environment — install it "
                "(e.g. pdv.install('wxPython')) and retry",
            )
            _preflight_cache[key] = verdict
            return verdict
        label = "wxPython"
    elif not _module_available("gi"):
        verdict = (False, "PyGObject (gi) is not installed")
        _preflight_cache[key] = verdict
        return verdict

    ok, why = _run_subprocess(_preflight_snippet(family, qt_module), timeout)
    if ok:
        verdict = (True, "")
    else:
        display = _display_env()
        where = f" on DISPLAY {display}" if display else ""
        if "died with signal" in why:
            # The exact process-fatal class this module exists to contain.
            why = f"{label} {why}{where} — the kernel would have crashed"
        else:
            why = f"{label} {why}{where}"
        verdict = (False, why)
    _preflight_cache[key] = verdict
    return verdict


def _current_backend_name() -> str | None:
    """Return the configured backend without triggering auto-resolution.

    ``matplotlib.get_backend()`` *resolves* the backend in mpl ≥3.9 — on a
    headless host that resolution is exactly the side effect this module
    avoids. ``auto_select=False`` (mpl ≥3.10) returns None instead.

    Returns
    -------
    str or None
        The backend name, or None when none is configured / resolvable
        without side effects.
    """
    import matplotlib  # noqa: PLC0415

    try:
        return matplotlib.get_backend(auto_select=False)
    except TypeError:
        # Provisional API — fall back to the private accessor it wraps.
        try:
            return matplotlib.rcParams._get_backend_or_none()
        except Exception:  # noqa: BLE001 — never let introspection break config
            return None


def _user_configured_backend() -> str | None:
    """Return a deliberately configured backend, or None.

    A backend set via ``MPLBACKEND`` or an earlier ``matplotlib.use()`` is
    the user's choice. Inline/Agg sentinels do not count — they are the
    ambient defaults ipykernel imposes (it forces
    ``MPLBACKEND=module://matplotlib_inline.backend_inline`` when unset, so
    matplotlibrc alone never surfaces here).

    Returns
    -------
    str or None
        The configured backend name (lowercased), or None when nothing
        non-trivial is configured.
    """
    current = (_current_backend_name() or "").lower()
    if current not in _TRIVIAL_BACKENDS:
        return current
    return None


def check_gui_allowed(gui: Any) -> tuple[bool, str]:
    """Decide whether enabling ``gui`` is safe for the kernel process.

    Shared by :func:`configure` (bootstrap) and the ``%matplotlib`` guard.
    Non-display guis and non-probe platforms (macOS/Windows) are always
    allowed — their failures are ordinary catchable exceptions; elsewhere
    display guis must pass the display probe and the subprocess pre-flight.

    Side effect: for Qt families this steers ``QT_API`` via
    :func:`_ensure_qt_api` — deliberate and load-bearing, because
    matplotlib's ``qt_compat`` reads it at import and the pre-flight child
    must inherit the same steering.

    Parameters
    ----------
    gui : str or None
        The gui/backend name handed to ``enable_matplotlib``.

    Returns
    -------
    tuple of (bool, str)
        ``(True, "")`` when the switch may proceed, else ``(False, reason)``
        with a human-readable, actionable reason.
    """
    if gui is None:
        return (True, "")
    name = str(gui).lower()
    if name in _ALWAYS_ALLOWED:
        return (True, "")
    if not _is_probe_platform():
        return (True, "")
    family = _GUI_FAMILIES.get(name)
    if family is None:
        # Unknown spelling — let IPython produce its normal error.
        return (True, "")
    state, display = _display_gate()
    if state == "none":
        return (
            False,
            "this session has no display for native windows — X forwarding "
            "is not active. To enable it, turn on ForwardX11 for this host "
            "in your SSH config (with an X server such as XQuartz running "
            "locally) and start a new session",
        )
    if state == "dead":
        return (
            False,
            f"DISPLAY {display} is no longer reachable — its X forwarding "
            "has gone away. Start a new session to re-establish it",
        )
    if family in ("qt", "qt5", "qt6"):
        _ensure_qt_api(family)
    ok, why = preflight_gui(family)
    if not ok:
        return (False, why)
    return (True, "")


def _clear_gui_select(ip: Any) -> None:
    """Release IPython's one-shot GUI-toolkit selection after bootstrap.

    ``enable_matplotlib`` records the first GUI it enables in
    ``pylab_gui_select`` and refuses to change toolkits afterwards. That
    one shot belongs to the *user*: if bootstrap's auto-selection consumed
    it, the user's first explicit ``%matplotlib <gui>`` would print
    IPython's "Cannot change to a different GUI toolkit" and silently do
    nothing — a regression against pre-B4 behavior, where bootstrap never
    touched it.

    Parameters
    ----------
    ip : InteractiveShell
        The shell whose selection to release. Missing attribute is a no-op.
    """
    try:
        if getattr(ip, "pylab_gui_select", None) is not None:
            ip.pylab_gui_select = None
    except Exception:  # noqa: BLE001 — cosmetic state, never fail bootstrap
        pass


def _install_enable_matplotlib_guard(ip: Any) -> None:
    """Wrap ``ip.enable_matplotlib`` with the safety checks.

    ``%matplotlib <gui>`` dispatches through this bound method, so shadowing
    it on the shell instance intercepts every user-invoked backend switch.
    On refusal the wrapper prints one line and returns a ``(gui, backend)``
    2-tuple — the magic unpacks the return value, so the shape matters.
    Refusing *before* the original call keeps ``pylab_gui_select`` unset,
    so a retry after fixing the display succeeds cleanly.

    Parameters
    ----------
    ip : InteractiveShell
        The shell whose ``enable_matplotlib`` gets guarded. Idempotent —
        an already-guarded method is left untouched.
    """
    original = ip.enable_matplotlib
    if getattr(original, "_pdv_guarded", False) is True:
        return

    def _guarded_enable_matplotlib(gui: Any = None) -> tuple:
        ok, reason = check_gui_allowed(gui)
        if not ok:
            print(
                f"PDV: refusing %matplotlib {gui}: {reason}. Plots stay "
                "inline — they render in the PDV console."
            )
            selected = getattr(ip, "pylab_gui_select", None) or "inline"
            return (selected, _current_backend_name() or "inline")
        # A sanctioned switch supersedes the inline state — the pending
        # "plots render inline because ..." notice no longer applies.
        _disarm_inline_notice()
        return original(gui)

    _guarded_enable_matplotlib._pdv_guarded = True  # type: ignore[attr-defined]
    _guarded_enable_matplotlib._pdv_original = original  # type: ignore[attr-defined]
    ip.enable_matplotlib = _guarded_enable_matplotlib


def _arm_inline_notice(reason: str) -> None:
    """Print ``reason`` once, on the user's first ``plt.show()``.

    Bootstrap output lands in the handshake's boot tail, which the user
    never sees on a successful start — so a session that silently fell
    back to inline would leave them wondering why no window appeared.
    Deferring the explanation to the first ``plt.show()`` puts it directly
    above the first inline figure, where it answers the question the user
    is actually asking at that moment.

    Parameters
    ----------
    reason : str
        The one-line explanation for the inline fallback.
    """
    try:
        import matplotlib.pyplot as plt  # noqa: PLC0415
    except ImportError:
        return

    original = plt.show

    def _noticed_show(*args, **kwargs):
        plt.show = original
        print(f"PDV: {reason} — plots render inline in the PDV console.")
        return original(*args, **kwargs)

    _noticed_show._pdv_inline_notice = True  # type: ignore[attr-defined]
    _noticed_show._pdv_original_show = original  # type: ignore[attr-defined]
    plt.show = _noticed_show


def _disarm_inline_notice() -> None:
    """Remove a pending first-show notice, if one is armed."""
    try:
        import matplotlib.pyplot as plt  # noqa: PLC0415
    except ImportError:
        return
    if getattr(plt.show, "_pdv_inline_notice", False) is True:
        plt.show = plt.show._pdv_original_show


def _fallback_inline(enable: Any, reason: str | None) -> None:
    """Enable the inline backend, or degrade to the Agg shim.

    Parameters
    ----------
    enable : callable
        The *original* (unguarded) ``enable_matplotlib`` bound method.
    reason : str or None
        One-line explanation printed at bootstrap (boot tail) and re-printed
        on the first ``plt.show()`` (None = silent, e.g. when inline is
        simply the platform outcome without a failure).
    """
    global decision, decision_reason  # noqa: PLW0603

    decision = "inline"
    decision_reason = reason
    if reason:
        print(f"PDV: {reason} — plots will render inline in the PDV console.")
    try:
        enable("inline")
    except Exception:  # noqa: BLE001 — inline must never fail bootstrap
        import matplotlib  # noqa: PLC0415

        matplotlib.use("Agg")
        _patch_plt_show_for_inline_capture()
    if reason:
        _arm_inline_notice(reason)


def configure(ip: Any) -> None:
    """Choose and enable a matplotlib backend for this kernel.

    Called once from :func:`pdv.bootstrap`. macOS/Windows auto-enable a
    native backend (ordinary catchable failures); probe platforms boot
    the handshake on inline and, when a live display and a pre-flighted
    Qt binding exist, switch to qt one-shot before the user's first
    execution (see the module docstring for why the deferral). Always
    installs the ``%matplotlib`` guard, even when honoring a
    user-configured backend. Silently skips if matplotlib is not
    installed.

    Parameters
    ----------
    ip : InteractiveShell or None
        The IPython shell. Without a real shell (or one lacking
        ``enable_matplotlib``), falls back to Agg plus the inline
        ``plt.show()`` shim — parity with historical plain-python behavior.
    """
    global decision, decision_reason  # noqa: PLW0603

    decision = None
    decision_reason = None

    try:
        import matplotlib  # noqa: PLC0415
    except ImportError:
        return

    if ip is None or not hasattr(ip, "enable_matplotlib"):
        matplotlib.use("Agg")
        _patch_plt_show_for_inline_capture()
        decision = "inline"
        return

    enable = ip.enable_matplotlib
    _install_enable_matplotlib_guard(ip)

    configured = _user_configured_backend()
    if configured is not None:
        # Honor the user's MPLBACKEND / earlier matplotlib.use() — but
        # through enable_matplotlib (so it gets the event loop; a bare
        # rcParams setting reproduces the frozen-window bug), and through
        # the same safety checks (MPLBACKEND=qtagg + stale DISPLAY would
        # otherwise abort the kernel on the first figure).
        ok, reason = check_gui_allowed(configured)
        if not ok:
            _fallback_inline(
                enable, f"configured backend {configured} was refused ({reason})"
            )
            return
        try:
            enable(configured)
            _clear_gui_select(ip)
        except Exception:  # noqa: BLE001 — keep the user's setting; pre-B4 parity
            pass
        decision = "user"
        decision_reason = f"honoring configured backend {configured}"
        return

    if not _is_probe_platform():
        # macOS / Windows: every failure mode here is a catchable
        # exception, so try/except suffices and adds zero latency to the
        # common case.
        platform = _platform()
        candidates = ["osx", "tk"] if platform == "darwin" else ["tk", "qt"]
        for gui in candidates:
            try:
                enable(gui)
                _clear_gui_select(ip)
                decision = gui
                return
            except Exception:  # noqa: BLE001 — fall through to the next toolkit
                continue
        _fallback_inline(enable, None)
        return

    state, display = _display_gate()
    if state == "none":
        _fallback_inline(enable, "no DISPLAY is available")
        return
    if state == "dead":
        _fallback_inline(
            enable,
            f"DISPLAY {display} is no longer reachable (its X forwarding "
            "has gone away)",
        )
        return

    # Live display: plots default to native windows via qt — but the event
    # loop is enabled DEFERRED, just before the user's first execution,
    # never mid-handshake. Rationale, from CI: a GUI event loop started
    # during bootstrap can starve the session handshake even when the
    # toolkit pre-flighted green (ipykernel's loop_tk under Xvfb starved
    # pdv.init until the session timed out). Qt's loop is the one with
    # field mileage (live feyn validation), so qt is the only AUTO
    # candidate; tk/gtk stay opt-in through the guarded %matplotlib.
    if _choose_qt_binding("qt") is not None:
        _ensure_qt_api("qt")
        ok, why = preflight_gui("qt")
        if ok:
            try:
                enable("inline")
            except Exception:  # noqa: BLE001 — inline must never fail bootstrap
                matplotlib.use("Agg")
                _patch_plt_show_for_inline_capture()
            decision = "qt-deferred"
            _arm_deferred_gui(ip, enable, "qt")
            return
        _fallback_inline(enable, why)
        return
    _fallback_inline(enable, None)



def _apply_gui_now(ip: Any, enable: Any, gui: str) -> None:
    """Enable *gui* for a session that booted inline (deferred switch).

    Re-runs the safety checks first — the environment may have changed
    between bootstrap and the first execution (a stale display re-probes
    thanks to the env-keyed pre-flight cache), and a refusal here prints
    into the user's first cell output, where they can actually see it.
    Never raises: a failure leaves the already-working inline backend in
    place.

    Parameters
    ----------
    ip : InteractiveShell
        The shell.
    enable : callable
        The original (unguarded) ``enable_matplotlib`` bound method.
    gui : str
        The gui to enable (``qt``).
    """
    global decision, decision_reason  # noqa: PLW0603

    try:
        ok, reason = check_gui_allowed(gui)
        if not ok:
            decision = "inline"
            decision_reason = reason
            print(f"PDV: {reason} — plots stay inline in the PDV console.")
            return
        enable(gui)
        _clear_gui_select(ip)
        decision = gui
        decision_reason = None
    except Exception:  # noqa: BLE001 — inline is active; never break execution
        decision = "inline"


def _arm_deferred_gui(ip: Any, enable: Any, gui: str) -> None:
    """Apply *gui* one-shot, just before the user's first execution.

    The session handshake completes on the inline backend; the GUI event
    loop starts only once the kernel is fully up, immediately ahead of the
    first cell — the earliest moment a window could matter and the latest
    moment that keeps startup structurally immune to event-loop
    misbehavior. Shells without the events machinery (test doubles) get
    the switch applied immediately instead.

    Parameters
    ----------
    ip : InteractiveShell
        The shell whose ``pre_execute`` event triggers the switch.
    enable : callable
        The original (unguarded) ``enable_matplotlib`` bound method.
    gui : str
        The gui to enable (``qt``).
    """
    applied = {"done": False}

    def _deferred_gui_hook() -> None:
        if applied["done"]:
            return
        applied["done"] = True
        try:
            ip.events.unregister("pre_execute", _deferred_gui_hook)
        except Exception:  # noqa: BLE001 — unregister failure must not matter
            pass
        _apply_gui_now(ip, enable, gui)

    try:
        ip.events.register("pre_execute", _deferred_gui_hook)
    except Exception:  # noqa: BLE001 — no events machinery: apply immediately
        _apply_gui_now(ip, enable, gui)


def _patch_plt_show_for_inline_capture() -> None:
    """Monkey-patch ``plt.show()`` to emit figures as display_data messages.

    Legacy fallback, used only when there is no real IPython shell to
    enable the ``matplotlib-inline`` backend on (or when enabling it
    failed). Idempotent — an already-installed shim is left in place. The
    original ``plt.show`` is stashed on the wrapper as
    ``_pdv_original_show`` so tests can restore it.
    """
    try:
        import matplotlib.pyplot as plt  # noqa: PLC0415
    except ImportError:
        return

    if getattr(plt.show, "_pdv_inline_shim", False) is True:
        return

    original_show = plt.show

    def _pdv_inline_show(*args, **kwargs):
        _ = (args, kwargs)  # swallow block= and other kwargs
        try:
            import io  # noqa: PLC0415

            fig = plt.gcf()
            buf = io.BytesIO()
            fig.savefig(buf, format="png", bbox_inches="tight")
            png = buf.getvalue()
            buf.close()

            try:
                from IPython.display import Image, display  # noqa: PLC0415

                display(Image(data=png, format="png"))
            except ImportError:
                # IPython not available — nothing we can do
                pass

            plt.close(fig)
        except Exception as exc:  # noqa: BLE001 — never raise from a show()
            print(f"[PDV] Could not capture figure: {exc}")

    _pdv_inline_show._pdv_inline_shim = True  # type: ignore[attr-defined]
    _pdv_inline_show._pdv_original_show = original_show  # type: ignore[attr-defined]
    plt.show = _pdv_inline_show
    print(
        "[PDV] No interactive matplotlib backend found — figures will "
        "render inline in the PDV console."
    )
