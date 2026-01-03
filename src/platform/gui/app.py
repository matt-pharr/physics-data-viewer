"""Frontend application scaffold coordinating windows and backend client."""

from __future__ import annotations

import inspect
import asyncio
from typing import Awaitable, Callable, Optional

from .client import BackendClient, ExecuteResult
from .window_manager import BaseWindow, WindowManager

HotReloadCallback = Callable[[], Optional[Awaitable[None]]]


class FrontendApp:
    """Coordinating object representing the frontend runtime."""

    def __init__(
        self,
        backend_url: str = "http://localhost:8000",
        client: Optional[BackendClient] = None,
        default_title: str = "Physics Data Viewer",
    ) -> None:
        self.backend_url = backend_url
        self.client = client
        self.window_manager = WindowManager()
        self.default_session_id: Optional[str] = None
        self.dev_mode = False
        self.default_title = default_title
        self._client_loop: Optional[asyncio.AbstractEventLoop] = None
        self._user_client_provided = client is not None
        self._hot_reload_callbacks: list[HotReloadCallback] = []

    async def start(self, dev_mode: bool = False) -> BaseWindow:
        """Start the frontend and establish connectivity to the backend."""
        await self._ensure_client()
        self.dev_mode = dev_mode
        self.default_session_id = await self.client.connect()
        window = self.window_manager.create_window(
            title=self.default_title, session_id=self.default_session_id, dev_mode=dev_mode
        )
        if dev_mode:
            self.register_hot_reload_callback(self._reload_active_windows)
        return window

    async def new_window(self, title: str = "Additional Window") -> BaseWindow:
        """Create a new window backed by its own session."""
        await self._ensure_client()
        session_id = await self.client.connect()
        return self.window_manager.create_window(title=title, session_id=session_id, dev_mode=self.dev_mode)

    async def send_command(self, code: str, *, window_id: Optional[str] = None) -> ExecuteResult:
        """Execute code using the session associated with the given window or default session."""
        await self._ensure_client()
        session = self.default_session_id
        if window_id:
            target_window = self.window_manager.get_window(window_id)
            if target_window is None:
                raise ValueError(f"Window {window_id} does not exist.")
            session = target_window.session_id
        if session is None:
            raise RuntimeError("Frontend not started; call start() first.")
        return await self.client.execute(code, session_id=session)

    def register_hot_reload_callback(self, callback: HotReloadCallback) -> None:
        """Register a callback executed when hot-reload is triggered."""
        self._hot_reload_callbacks.append(callback)

    async def trigger_hot_reload(self) -> None:
        """Invoke all registered hot-reload callbacks."""
        for callback in self._hot_reload_callbacks:
            result = callback()
            if inspect.isawaitable(result):
                await result

    async def _reload_active_windows(self) -> None:
        """Simple hot-reload handler recreating tracked windows."""
        existing = tuple(self.window_manager.list_windows())
        self.window_manager = WindowManager()
        for window in existing:
            self.window_manager.create_window(
                title=window.title,
                session_id=window.session_id,
                route=window.route,
                dev_mode=self.dev_mode,
                window_id=window.window_id,
            )

    async def shutdown(self) -> None:
        """Shutdown the frontend and close resources."""
        if self.client:
            await self.client.aclose()
        self._client_loop = None

    async def _ensure_client(self) -> None:
        """Ensure the backend client is bound to the current event loop."""
        loop = asyncio.get_running_loop()
        if self.client is None:
            self.client = BackendClient(self.backend_url)
            self._client_loop = loop
            return
        if self._client_loop is None:
            self._client_loop = loop
            return
        if self._client_loop is loop:
            return
        if self._user_client_provided:
            raise RuntimeError(
                "FrontendApp client cannot be reused across event loops; create a new FrontendApp for each loop."
            )
        await self.client.aclose()
        self.client = BackendClient(self.backend_url)
        self._client_loop = loop
