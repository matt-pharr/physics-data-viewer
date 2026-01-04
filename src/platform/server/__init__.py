"""Server package initialization."""

from importlib import import_module

__all__ = ["create_app"]


def __getattr__(name):
    if name == "create_app":
        return import_module("platform.server.app").create_app
    raise AttributeError(name)
