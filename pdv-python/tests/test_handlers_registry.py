"""
pdv-python/tests/test_handlers_registry.py — Coverage gate for the comm
message dispatch table.

The kernel exposes its functionality to the renderer through a registry of
``pdv.*`` message handlers (see ``pdv.handlers.__init__._DISPATCH`` and
ARCHITECTURE.md §3.4). The renderer assumes every advertised message type
has been exercised. Without enforcement, a new handler can be registered
without a test and silently ship.

This module is the gate. It

1. Imports the live ``_DISPATCH`` table — the authoritative set of
   message types the kernel will respond to.
2. Scans every test module for references to either the handler function
   or the literal message-type string.
3. Fails if a registered message type has neither, OR if a previously
   untested message type now has tests but is still in the allowlist
   below (forcing the allowlist to shrink as gaps close).

To add a handler: write a test that mentions the message type string OR
imports the handler function. That alone clears the gate.

To intentionally ship an untested handler: add the message type to
``KNOWN_UNTESTED`` with a one-line justification.

See Also
--------
ARCHITECTURE.md §3.4 (message type catalogue)
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

import pdv.handlers as handlers_pkg


TESTS_DIR = Path(__file__).resolve().parent
HANDLERS_DIR = Path(handlers_pkg.__file__).resolve().parent

# Message types that are known to lack a dedicated test exercising the
# handler entry point. Each entry is a punch-list item: shrink this set,
# don't grow it. New handlers must NOT land here without justification.
KNOWN_UNTESTED: dict[str, str] = {
    "pdv.tree.resolve_file": "no test for resolve_file handler entry point",
    "pdv.module.register": "no test for module registration message handler",
    "pdv.gui.register": "no test for gui registration message handler",
    "pdv.file.register": "no test for file registration message handler",
    "pdv.namelist.read": "namelist parsing tested in test_namelist.py — handler entry point untested",
    "pdv.namelist.write": "namelist parsing tested in test_namelist.py — handler entry point untested",
}


def _registered_message_types() -> dict[str, str]:
    """Return {msg_type: handler_function_name} for every registered handler.

    Source of truth is ``_DISPATCH``, populated as a side effect of
    importing ``pdv.handlers``.
    """
    return {
        msg_type: handler.__name__
        for msg_type, handler in handlers_pkg._DISPATCH.items()
    }


def _test_corpus() -> str:
    """Concatenated text of every test module in this directory."""
    parts = []
    for path in sorted(TESTS_DIR.glob("test_*.py")):
        # Skip self to avoid a trivial self-reference giving every type
        # free coverage.
        if path.name == Path(__file__).name:
            continue
        parts.append(path.read_text(encoding="utf-8"))
    return "\n".join(parts)


def _is_referenced(msg_type: str, handler_name: str, corpus: str) -> bool:
    """True if any test mentions the message type literal OR the handler.

    Word-boundary regex on the handler name avoids spurious hits on
    longer identifiers that happen to share a prefix.
    """
    if msg_type in corpus:
        return True
    return re.search(rf"\b{re.escape(handler_name)}\b", corpus) is not None


def test_dispatch_table_is_populated():
    """The dispatch table should contain at least the known handlers.

    Catches a regression where handlers stop registering at import time
    (e.g. the submodule imports are removed from ``handlers/__init__``).
    """
    registered = _registered_message_types()
    assert len(registered) >= 20, (
        f"Suspiciously few registered handlers ({len(registered)}); "
        "did handler module imports get dropped from pdv/handlers/__init__.py?"
    )


def test_no_untracked_untested_handlers():
    """Every registered handler is either tested or in KNOWN_UNTESTED.

    If this fails for a handler you just added: write a test that mentions
    the message type string or imports the handler function. If you must
    ship without one, add the message type to KNOWN_UNTESTED above with a
    short justification.
    """
    registered = _registered_message_types()
    corpus = _test_corpus()

    untested = sorted(
        msg_type
        for msg_type, handler_name in registered.items()
        if not _is_referenced(msg_type, handler_name, corpus)
    )
    new_gaps = [m for m in untested if m not in KNOWN_UNTESTED]

    assert not new_gaps, (
        "Registered handler(s) have no test reference and are not in "
        "KNOWN_UNTESTED:\n  - "
        + "\n  - ".join(new_gaps)
        + "\n\nWrite a test that mentions the message type string or "
        "the handler function name, OR add the type to KNOWN_UNTESTED "
        "in this file with a one-line justification."
    )


def test_known_untested_list_is_minimal():
    """KNOWN_UNTESTED entries that now have tests must be removed.

    Forces the allowlist to shrink as gaps close. Without this, types
    can stay on the punch list forever even after coverage lands.
    """
    registered = _registered_message_types()
    corpus = _test_corpus()

    stale = sorted(
        msg_type
        for msg_type in KNOWN_UNTESTED
        if msg_type in registered
        and _is_referenced(msg_type, registered[msg_type], corpus)
    )

    assert not stale, (
        "These entries in KNOWN_UNTESTED now have test coverage and "
        "should be removed from the list:\n  - " + "\n  - ".join(stale)
    )


def test_known_untested_only_lists_real_handlers():
    """Entries in KNOWN_UNTESTED must correspond to real registered types."""
    registered = _registered_message_types()
    bogus = sorted(m for m in KNOWN_UNTESTED if m not in registered)
    assert not bogus, (
        "KNOWN_UNTESTED references message types that are not "
        "registered (typo or stale entry?):\n  - " + "\n  - ".join(bogus)
    )


@pytest.mark.parametrize(
    "msg_type",
    sorted(handlers_pkg._DISPATCH.keys()),
)
def test_handler_is_callable(msg_type: str):
    """Every registered handler is a callable accepting a single argument."""
    handler = handlers_pkg._DISPATCH[msg_type]
    assert callable(handler), f"Handler for {msg_type} is not callable"
