"""
Summarize a numeric list from pdv_tree and write a summary node.
"""


def run(
    pdv_tree: dict,
    source_path: str = "demo.dataset",
    result_path: str = "demo.summary",
    **user_params,
) -> dict:
    source = pdv_tree.get(source_path, {})
    values = source.get("values") if isinstance(source, dict) else None
    if not isinstance(values, list):
        return {
            "ok": False,
            "error": f'Expected "{source_path}" to contain dict.values list',
        }

    numeric = [float(item) for item in values if isinstance(item, (int, float))]
    if not numeric:
        return {"ok": False, "error": "No numeric values available for summary"}

    summary = {
        "count": len(numeric),
        "min": min(numeric),
        "max": max(numeric),
        "mean": sum(numeric) / len(numeric),
        "source_path": source_path,
        "user_params": user_params,
    }
    pdv_tree[result_path] = summary
    return {"ok": True, "result_path": result_path, **summary}
