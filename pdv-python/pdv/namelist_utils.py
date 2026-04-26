"""
pdv.namelist_utils — Namelist file parsing and writing utilities.

Pure utility module with no dependency on comms, handlers, or IPython.

Supports:
- Fortran namelists (``.in``, ``.nml``) via ``f90nml``
- TOML files (``.toml``) via ``tomllib`` (stdlib 3.11+) and ``tomli_w``

All third-party imports are lazy so that the module can be imported
without ``f90nml`` or ``tomli_w`` installed.
"""

from __future__ import annotations

import os
import re
from typing import Any


def detect_namelist_format(file_path: str) -> str:
    """Detect namelist format from file extension.

    Parameters
    ----------
    file_path : str
        Path to the namelist file.

    Returns
    -------
    str
        ``'fortran'`` for ``.in``/``.nml``, ``'toml'`` for ``.toml``.

    Raises
    ------
    ValueError
        If the extension is unrecognised.
    """
    ext = os.path.splitext(file_path)[1].lower()
    if ext in (".in", ".nml"):
        return "fortran"
    if ext == ".toml":
        return "toml"
    raise ValueError(f"Cannot detect namelist format for extension '{ext}'")


def read_namelist(file_path: str, format: str = "auto") -> dict:
    """Parse a namelist file and return structured data.

    Parameters
    ----------
    file_path : str
        Absolute path to the namelist file.
    format : str
        ``'fortran'``, ``'toml'``, or ``'auto'`` (detect from extension).

    Returns
    -------
    dict
        ``{group_name: {key: value, ...}, ...}``
    """
    if format == "auto":
        format = detect_namelist_format(file_path)

    if format == "fortran":
        return _read_fortran(file_path)
    if format == "toml":
        return _read_toml(file_path)
    raise ValueError(f"Unsupported namelist format: '{format}'")


def write_namelist(file_path: str, data: dict, format: str = "auto") -> None:
    """Write structured data to a namelist file.

    Parameters
    ----------
    file_path : str
        Absolute path to the output file.
    data : dict
        ``{group_name: {key: value, ...}, ...}``
    format : str
        ``'fortran'``, ``'toml'``, or ``'auto'`` (detect from extension).
    """
    if format == "auto":
        format = detect_namelist_format(file_path)

    if format == "fortran":
        _write_fortran(file_path, data)
    elif format == "toml":
        _write_toml(file_path, data)
    else:
        raise ValueError(f"Unsupported namelist format: '{format}'")


def extract_hints(file_path: str, format: str = "auto") -> dict:
    """Extract comment hints adjacent to keys in a namelist file.

    For Fortran files, captures ``! comment`` on the same line or the
    line immediately preceding a key assignment. For TOML files, captures
    ``# comment`` similarly.

    Parameters
    ----------
    file_path : str
        Absolute path to the namelist file.
    format : str
        ``'fortran'``, ``'toml'``, or ``'auto'``.

    Returns
    -------
    dict
        ``{group_name: {key: hint_string, ...}, ...}``
    """
    if format == "auto":
        format = detect_namelist_format(file_path)

    try:
        with open(file_path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return {}

    if format == "fortran":
        return _extract_hints_fortran(lines)
    if format == "toml":
        return _extract_hints_toml(lines)
    return {}


def infer_types(data: dict) -> dict:
    """Infer value types for renderer field selection.

    Parameters
    ----------
    data : dict
        ``{group_name: {key: value, ...}, ...}``

    Returns
    -------
    dict
        ``{group_name: {key: type_string, ...}, ...}``
        Where type_string is one of ``'int'``, ``'float'``, ``'bool'``,
        ``'str'``, ``'array'``.
    """
    result: dict[str, dict[str, str]] = {}
    for group, entries in data.items():
        if not isinstance(entries, dict):
            continue
        group_types: dict[str, str] = {}
        for key, value in entries.items():
            group_types[key] = _infer_single_type(value)
        result[group] = group_types
    return result


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _read_fortran(file_path: str) -> dict:
    """Read a Fortran namelist file via f90nml."""
    try:
        import f90nml  # noqa: PLC0415
    except ImportError as exc:
        raise ImportError(
            "f90nml is required to read Fortran namelists. "
            "Install it with: pip install f90nml"
        ) from exc
    nml = f90nml.read(file_path)
    # f90nml returns an OrderedDict-like Namelist object; convert to plain dicts
    return {group: dict(entries) for group, entries in nml.items()}


def _write_fortran(file_path: str, data: dict) -> None:
    """Write a Fortran namelist file via f90nml."""
    try:
        import f90nml  # noqa: PLC0415
    except ImportError as exc:
        raise ImportError(
            "f90nml is required to write Fortran namelists. "
            "Install it with: pip install f90nml"
        ) from exc
    nml = f90nml.Namelist(data)
    nml.write(file_path, force=True)


def _read_toml(file_path: str) -> dict:
    """Read a TOML file."""
    import tomllib  # noqa: PLC0415  (stdlib 3.11+)

    with open(file_path, "rb") as fh:
        return tomllib.load(fh)


def _write_toml(file_path: str, data: dict) -> None:
    """Write a TOML file via tomli_w."""
    try:
        import tomli_w  # noqa: PLC0415
    except ImportError as exc:
        raise ImportError(
            "tomli_w is required to write TOML files. "
            "Install it with: pip install tomli-w"
        ) from exc
    with open(file_path, "wb") as fh:
        tomli_w.dump(data, fh)


def _extract_hints_fortran(lines: list[str]) -> dict:
    """Extract comment hints from Fortran namelist lines."""
    hints: dict[str, dict[str, str]] = {}
    current_group: str | None = None
    prev_comment: str | None = None

    # Regex for namelist group header: &group_name
    group_re = re.compile(r"^\s*&(\w+)")
    # Regex for key = value ! comment
    key_re = re.compile(r"^\s*(\w[\w%]*)(\([^)]*\))?\s*=")
    # Regex for inline comment
    inline_comment_re = re.compile(r"!\s*(.*?)\s*$")
    # Regex for standalone comment line
    comment_line_re = re.compile(r"^\s*!\s*(.*?)\s*$")

    for line in lines:
        # Check for group header
        gm = group_re.match(line)
        if gm:
            current_group = gm.group(1)
            if current_group not in hints:
                hints[current_group] = {}
            prev_comment = None
            continue

        # Check for standalone comment
        cm = comment_line_re.match(line)
        if cm:
            prev_comment = cm.group(1)
            continue

        # Check for key assignment
        km = key_re.match(line)
        if km and current_group is not None:
            key = km.group(1)
            # Check for inline comment
            im = inline_comment_re.search(line)
            if im:
                hints[current_group][key] = im.group(1)
            elif prev_comment:
                hints[current_group][key] = prev_comment
            prev_comment = None
            continue

        # End of group
        if line.strip() == "/" or line.strip().startswith("/"):
            current_group = None
            prev_comment = None
            continue

        prev_comment = None

    return hints


def _extract_hints_toml(lines: list[str]) -> dict:
    """Extract comment hints from TOML lines."""
    hints: dict[str, dict[str, str]] = {}
    current_group: str | None = None
    prev_comment: str | None = None

    # Regex for [section] header
    section_re = re.compile(r"^\s*\[([^\]]+)\]")
    # Regex for key = value
    key_re = re.compile(r"^\s*(\w[\w.-]*)\s*=")
    # Regex for inline comment
    inline_comment_re = re.compile(r"#\s*(.*?)\s*$")
    # Regex for standalone comment line
    comment_line_re = re.compile(r"^\s*#\s*(.*?)\s*$")

    for line in lines:
        sm = section_re.match(line)
        if sm:
            current_group = sm.group(1).strip()
            if current_group not in hints:
                hints[current_group] = {}
            prev_comment = None
            continue

        cm = comment_line_re.match(line)
        if cm:
            prev_comment = cm.group(1)
            continue

        km = key_re.match(line)
        if km:
            key = km.group(1)
            group = current_group or "_root"
            if group not in hints:
                hints[group] = {}
            im = inline_comment_re.search(line)
            if im:
                hints[group][key] = im.group(1)
            elif prev_comment:
                hints[group][key] = prev_comment
            prev_comment = None
            continue

        prev_comment = None

    return hints


def _infer_single_type(value: Any) -> str:
    """Infer the type string for a single value."""
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int):
        return "int"
    if isinstance(value, float):
        return "float"
    if isinstance(value, str):
        return "str"
    if isinstance(value, (list, tuple)):
        return "array"
    return "str"
