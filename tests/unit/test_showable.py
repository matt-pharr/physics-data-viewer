from platform.types.showable import Plottable, Showable, ShowablePlottable
from platform.utils.introspection import describe_capabilities, supports_plot, supports_show


class OnlyShow:
    def show(self) -> str:
        return "only show"


class OnlyPlot:
    def plot(self):
        return {"plotted": True}


class FullImplementation:
    def show(self) -> str:
        return "representation"

    def plot(self):
        return {"plot": True}


class NeedsArgs:
    def show(self, required):
        return str(required)


def test_showable_protocol_and_introspection():
    obj = FullImplementation()
    assert supports_show(obj)
    assert supports_plot(obj)
    assert describe_capabilities(obj) == {"show": True, "plot": True}
    assert isinstance(obj, ShowablePlottable)
    assert isinstance(obj, Showable)
    assert isinstance(obj, Plottable)


def test_partial_capabilities_detected():
    show_only = OnlyShow()
    plot_only = OnlyPlot()
    assert supports_show(show_only) is True
    assert supports_plot(show_only) is False
    assert supports_show(plot_only) is False
    assert supports_plot(plot_only) is True
    assert isinstance(show_only, Showable)
    assert not isinstance(show_only, ShowablePlottable)
    assert isinstance(plot_only, Plottable)


def test_methods_with_extra_arguments_are_rejected():
    obj = NeedsArgs()
    assert supports_show(obj) is False
