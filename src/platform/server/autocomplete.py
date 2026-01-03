"""Autocomplete logic for Python command input."""

from __future__ import annotations

import builtins
import keyword
import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

LOG = logging.getLogger(__name__)


@dataclass
class CompletionItem:
    """A single completion suggestion."""

    label: str
    kind: str  # "keyword", "variable", "module", "function", "method"
    detail: Optional[str] = None
    documentation: Optional[str] = None
    insert_text: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to a dictionary for JSON serialization."""
        return {
            "label": self.label,
            "kind": self.kind,
            "detail": self.detail,
            "documentation": self.documentation,
            "insertText": self.insert_text or self.label,
        }


class AutocompleteEngine:
    """Generate autocomplete suggestions for Python code."""

    def __init__(self) -> None:
        # Cache Python keywords
        self._keywords = keyword.kwlist
        # Cache builtin names
        self._builtins = dir(builtins)

    def get_completions(
        self,
        code: str,
        position: int,
        namespace: Optional[Dict[str, Any]] = None,
    ) -> List[CompletionItem]:
        """
        Get completion suggestions for the given code at the specified position.

        Args:
            code: The Python code string
            position: Cursor position in the code (character offset)
            namespace: Current namespace/state dictionary

        Returns:
            List of completion items
        """
        namespace = namespace or {}

        # Extract the token being completed
        token = self._extract_token_at_position(code, position)
        if not token:
            return []

        completions: List[CompletionItem] = []

        # Add keyword completions
        completions.extend(self._get_keyword_completions(token))

        # Add namespace completions (variables, functions, etc.)
        completions.extend(self._get_namespace_completions(token, namespace))

        # Add builtin completions
        completions.extend(self._get_builtin_completions(token))

        # Sort by relevance (exact matches first, then alphabetically)
        completions.sort(key=lambda c: (not c.label.startswith(token), c.label.lower()))

        return completions

    def _extract_token_at_position(self, code: str, position: int) -> str:
        """
        Extract the token being completed at the cursor position.

        Args:
            code: The Python code string
            position: Cursor position

        Returns:
            The partial token being completed
        """
        if position > len(code):
            position = len(code)

        # Find the start of the token (alphanumeric and underscore)
        start = position
        while start > 0 and (code[start - 1].isalnum() or code[start - 1] == "_"):
            start -= 1

        # Extract token from start to position
        token = code[start:position]
        return token

    def _get_keyword_completions(self, token: str) -> List[CompletionItem]:
        """Get completions for Python keywords."""
        if not token:
            return []

        completions = []
        for kw in self._keywords:
            if kw.startswith(token):
                completions.append(
                    CompletionItem(
                        label=kw,
                        kind="keyword",
                        detail="Python keyword",
                    )
                )
        return completions

    def _get_namespace_completions(
        self, token: str, namespace: Dict[str, Any]
    ) -> List[CompletionItem]:
        """Get completions from the current namespace."""
        if not token:
            return []

        completions = []
        for name, value in namespace.items():
            if name.startswith("_"):  # Skip private variables
                continue
            if name.startswith(token):
                kind = self._get_value_kind(value)
                detail = self._get_value_detail(value)
                completions.append(
                    CompletionItem(
                        label=name,
                        kind=kind,
                        detail=detail,
                    )
                )
        return completions

    def _get_builtin_completions(self, token: str) -> List[CompletionItem]:
        """Get completions for builtin names."""
        if not token:
            return []

        completions = []
        for name in self._builtins:
            if name.startswith("_"):  # Skip private builtins
                continue
            if name.startswith(token):
                completions.append(
                    CompletionItem(
                        label=name,
                        kind="function",
                        detail="builtin",
                    )
                )
        return completions

    def _get_value_kind(self, value: Any) -> str:
        """Determine the kind of a value for completion purposes."""
        if callable(value):
            if hasattr(value, "__self__"):
                return "method"
            return "function"
        if isinstance(value, type):
            return "class"
        if hasattr(value, "__module__"):
            return "module"
        return "variable"

    def _get_value_detail(self, value: Any) -> Optional[str]:
        """Get detail text for a value."""
        try:
            type_name = type(value).__name__
            if callable(value):
                return f"callable: {type_name}"
            return type_name
        except Exception:  # noqa: BLE001
            return None
