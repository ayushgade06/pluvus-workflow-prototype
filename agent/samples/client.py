"""Thin HTTP client for the three agent endpoints used by the sample runner.

Uses urllib (stdlib only — no new dependency) so the runner works against a
running agent with nothing to install. The agent's endpoints require an API key
ONLY when AGENT_API_KEY is set on the server; the client forwards it from the
same env var when present (matching the /reclone-campaign X-Operator-Key pattern
noted in memory for the server, but here it's the agent's AGENT_API_KEY).
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any


class AgentClient:
    def __init__(self, base_url: str, *, api_key: str | None = None, timeout: float = 180.0) -> None:
        self.base_url = base_url.rstrip("/")
        # Forward the agent's shared secret if one is configured. Both header
        # forms are accepted by app.security._extract_presented_key.
        self.api_key = api_key if api_key is not None else os.getenv("AGENT_API_KEY")
        self.timeout = timeout

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url}{path}"
        data = json.dumps(payload).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
            headers["X-API-Key"] = self.api_key
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body)
        except urllib.error.HTTPError as exc:  # 4xx/5xx from the endpoint
            detail = exc.read().decode("utf-8", "replace")
            raise AgentHTTPError(path, exc.code, detail) from exc
        except urllib.error.URLError as exc:  # connection refused / DNS / timeout
            raise AgentConnectionError(path, str(exc.reason)) from exc

    def health(self) -> dict[str, Any]:
        url = f"{self.base_url}/health"
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=10.0) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def classify(self, message: str) -> dict[str, Any]:
        return self._post("/classify", {"message": message})

    def negotiate(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/negotiate", payload)

    def draft(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._post("/draft", payload)


class AgentHTTPError(RuntimeError):
    def __init__(self, path: str, code: int, detail: str) -> None:
        super().__init__(f"{path} returned HTTP {code}: {detail[:300]}")
        self.path = path
        self.code = code
        self.detail = detail


class AgentConnectionError(RuntimeError):
    def __init__(self, path: str, reason: str) -> None:
        super().__init__(f"could not reach the agent at {path}: {reason}")
        self.path = path
        self.reason = reason
