"""Internal loopback transport; the CLI owns the remote endpoint contract."""

from __future__ import annotations

import http.client
import ipaddress
import json
import os
from typing import Any
from urllib.parse import urlsplit

BRIDGE_URL_ENV = "ORIZU_REMOTE_RUNNER_BRIDGE_URL"


def _bridge_address() -> tuple[str, int, str]:
    raw = os.environ.get(BRIDGE_URL_ENV, "")
    if not raw:
        raise RuntimeError("remote_runner_bridge_required: launch through `orizu optimizations run-gepa`")
    try:
        url = urlsplit(raw)
        host = url.hostname or ""
        port = url.port
        if (url.scheme != "http" or not ipaddress.ip_address(host).is_loopback
                or url.username is not None or url.password is not None
                or url.fragment or port is None or port <= 0):
            raise ValueError("invalid bridge address")
        path = url.path or "/"
        if url.query:
            path += "?" + url.query
        return host, port, path
    except ValueError:
        # Never include a URL (or a transport exception containing it).
        raise RuntimeError("remote_runner_bridge_invalid: expected an HTTP literal-loopback address") from None


def require_remote_runner_bridge() -> None:
    if os.environ.get("ORIZU_HOSTED_OPTIMIZATION_RUN_ID", "").strip() and not os.environ.get(BRIDGE_URL_ENV):
        raise RuntimeError("remote_runner_not_supported_for_hosted_optimization: hosted remote runners are not supported yet (ORI-2817)")
    _bridge_address()


def request_bridge(method: str, *, max_bytes: int | None, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    host, port, path = _bridge_address()
    # No environment proxy, redirects, retries, or competing call deadline.
    # The CLI bounds the queued remote call and closes sockets on shutdown.
    connection = http.client.HTTPConnection(host, port, timeout=5 if method == "GET" else None)
    try:
        try:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
            connection.request(method, path, body=body,
                               headers={"Content-Type": "application/json"} if body is not None else {})
            response = connection.getresponse()
            encoded = response.read() if max_bytes is None else response.read(max_bytes + 1)
            if max_bytes is not None and len(encoded) > max_bytes:
                raise ValueError("oversized bridge response")
            data = json.loads(encoded)
            if not isinstance(data, dict):
                raise ValueError("invalid bridge response")
        except (OSError, http.client.HTTPException, ValueError, UnicodeError):
            raise RuntimeError("remote_runner_bridge_failed: unavailable or invalid bridge response") from None
        if response.status != 200:
            # Only the launcher's already-sanitized error field is printable.
            message = data.get("error")
            raise RuntimeError(message if isinstance(message, str) and message else "remote_runner_bridge_failed")
        return data
    finally:
        connection.close()


def read_remote_runner_summary(*, max_bytes: int) -> dict[str, Any]:
    summary = request_bridge("GET", max_bytes=max_bytes)
    rows = summary.get("live_data_rows")
    if (set(summary) != {"name", "runner_version_id", "deployed_version", "live_data_rows"}
            or not isinstance(summary["name"], str)
            or not isinstance(summary["runner_version_id"], str)
            or (summary["deployed_version"] is not None and not isinstance(summary["deployed_version"], str))
            or not isinstance(rows, list)
            or any(not isinstance(row, dict)
                   or set(row) != {"row_id", "live_data_inputs"}
                   or not isinstance(row["row_id"], str)
                   or not isinstance(row["live_data_inputs"], list)
                   or not all(isinstance(item, str) for item in row["live_data_inputs"])
                   for row in rows)):
        raise RuntimeError("remote_runner_bridge_failed: invalid bridge summary")
    return summary
