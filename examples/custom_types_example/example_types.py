"""Example custom data types implementing show/plot interfaces."""

from typing import Any

from platform.types.showable import Plottable, Showable, ShowablePlottable


class ShowableData(Showable):
    def __init__(self, value: Any):
        self.value = value

    def show(self) -> str:
        return f"Value: {self.value}"


class PlottableData(Plottable):
    def __init__(self, points: list[tuple[float, float]]):
        self.points = points

    def plot(self):
        return {"points": self.points}


class FullData(ShowablePlottable):
    def __init__(self, label: str, data: list[int]):
        self.label = label
        self.data = data

    def show(self) -> str:
        return f"{self.label}: {self.data}"

    def plot(self):
        return {"label": self.label, "data": self.data}
