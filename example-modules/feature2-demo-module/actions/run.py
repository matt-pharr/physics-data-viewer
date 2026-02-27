"""
Seed a deterministic demo dataset into pdv_tree.
"""


def run(
    pdv_tree: dict,
    target_path: str = "demo.dataset",
    count: int = 8,
    start: float = 1.0,
    step: float = 0.5,
    **user_params,
) -> dict:
    count = max(0, int(count))
    values = [start + index * step for index in range(count)]
    pdv_tree[target_path] = {
        "values": values,
        "meta": {
            "created_by": "feature2_demo_module.seed_dataset",
            "user_params": user_params,
        },
    }
    return {
        "ok": True,
        "target_path": target_path,
        "count": len(values),
        "first": values[0] if values else None,
        "last": values[-1] if values else None,
    }
