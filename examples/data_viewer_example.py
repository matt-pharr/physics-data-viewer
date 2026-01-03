"""Minimal usage example for the data viewer utilities."""

from platform.gui.data_viewer import DataViewer


def main() -> None:
    data = {"alpha": {"beta": [1, 2, 3]}, "gamma": {"delta": {"epsilon": 5}}}
    viewer = DataViewer(data, viewport_size=10, overscan=2)
    for depth, node in viewer.visible_window():
        indent = "  " * depth
        print(f"{indent}{node.key}: {node.formatted.preview}")


if __name__ == "__main__":  # pragma: no cover - convenience
    main()
