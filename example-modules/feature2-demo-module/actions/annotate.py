"""
Annotate an existing summary node with tags/flags.
"""


def run(
    pdv_tree: dict,
    source_path: str = "demo.summary",
    note: str = "checked",
    flagged: bool = True,
    **user_params,
) -> dict:
    current = pdv_tree.get(source_path, {})
    if not isinstance(current, dict):
        current = {"value": current}

    tags = current.get("tags", [])
    if not isinstance(tags, list):
        tags = [str(tags)]
    if note and note not in tags:
        tags.append(note)

    current["tags"] = tags
    current["flagged"] = bool(flagged)
    current["annotation_context"] = user_params
    pdv_tree[source_path] = current
    return {"ok": True, "source_path": source_path, "tags": tags, "flagged": bool(flagged)}
