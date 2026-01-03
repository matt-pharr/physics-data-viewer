"""Backend autocomplete logic for Python code completion."""

from __future__ import annotations

import builtins
import keyword
from typing import Any, Dict, List, Optional, Set


class AutocompleteProvider:
    """Provides autocomplete suggestions for Python code in REPL contexts."""

    def __init__(self) -> None:
        """Initialize the autocomplete provider with Python keywords and builtins."""
        self._python_keywords: Set[str] = set(keyword.kwlist)
        self._python_builtins: Set[str] = set(dir(builtins))

    def get_completions(
        self,
        code: str,
        cursor_position: Optional[int] = None,
        state: Optional[Dict[str, Any]] = None,
    ) -> List[str]:
        """
        Generate autocomplete suggestions for the given code.

        Args:
            code: The current input code
            cursor_position: Position of cursor in the code (defaults to end)
            state: Current session state (namespace variables)

        Returns:
            List of completion suggestions sorted alphabetically
        """
        if cursor_position is None:
            cursor_position = len(code)

        # Extract the current word being typed
        word_start = self._find_word_start(code, cursor_position)
        current_word = code[word_start:cursor_position]

        if not current_word:
            return []

        completions: Set[str] = set()

        # Add Python keywords
        completions.update(
            kw for kw in self._python_keywords if kw.startswith(current_word)
        )

        # Add Python builtins
        completions.update(
            builtin for builtin in self._python_builtins if builtin.startswith(current_word)
        )

        # Add state variables (namespace keys)
        if state:
            completions.update(
                key for key in state.keys() if isinstance(key, str) and key.startswith(current_word)
            )

        # Add common modules if importing
        if self._is_import_context(code, cursor_position):
            common_modules = self._get_common_modules()
            completions.update(
                mod for mod in common_modules if mod.startswith(current_word)
            )

        return sorted(completions)

    def _find_word_start(self, text: str, position: int) -> int:
        """Find the start position of the current word being typed."""
        if position == 0:
            return 0

        # Valid identifier characters
        i = position - 1
        while i >= 0:
            char = text[i]
            if not (char.isalnum() or char == "_"):
                return i + 1
            i -= 1

        return 0

    def _is_import_context(self, code: str, position: int) -> bool:
        """Check if the cursor is in an import statement context."""
        # Extract the current line
        line_start = code.rfind("\n", 0, position) + 1
        current_line = code[line_start:position]

        # Check for import statements
        stripped = current_line.strip()
        return (
            stripped.startswith("import ")
            or stripped.startswith("from ")
            or stripped == "import"
            or stripped == "from"
        )

    def _get_common_modules(self) -> Set[str]:
        """Return a set of commonly used Python modules in scientific computing."""
        return {
            # Standard library
            "os",
            "sys",
            "json",
            "math",
            "time",
            "datetime",
            "collections",
            "itertools",
            "functools",
            "pathlib",
            "re",
            "pickle",
            # Scientific stack
            "numpy",
            "scipy",
            "matplotlib",
            "pandas",
            "xarray",
            # Platform modules (if they exist in the future)
            "platform",
        }
