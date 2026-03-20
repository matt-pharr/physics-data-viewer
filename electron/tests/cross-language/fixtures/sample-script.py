"""Sample PDV script for cross-language equivalence tests."""


def run(pdv_tree: dict, x: int = 10, label: str = "default") -> dict:
    """Multiply x by 2 and store in tree."""
    pdv_tree["result"] = x * 2
    pdv_tree["label"] = label
    return pdv_tree
