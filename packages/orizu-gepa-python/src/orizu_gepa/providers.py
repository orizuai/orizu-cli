"""THE provider registry, read by the Python transport (ORI-2032).

One loader, in the package that owns the transport. The connector imports it
(``from orizu_gepa.providers import ...``) exactly as it already imports
``orizu_gepa.reflection``; there is no twin and no re-export shim.

The JSON this reads is GENERATED from ``packages/cli/src/provider-registry.ts``
by ``bun run generate:provider-registry``. Do not edit it by hand:
``test/provider-registry-json-parity.test.ts`` fails on drift.

A provider is a named connection — one wire protocol, one base URL, one
credential — never a vendor. Two providers may point at the same company and a
gateway is just a provider. See CONTEXT.md.
"""

from __future__ import annotations

import importlib.resources
import json
import os
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Any
from urllib.parse import urlsplit


REGISTRY_RESOURCE_PACKAGE = "orizu_gepa"
REGISTRY_RESOURCE_NAME = "providers.generated.json"
REGISTRY_SCHEMA_VERSION = "orizu.provider-registry.v1"

#: The path each wire protocol appends to a provider's base URL. This is the
#: whole protocol table as far as addressing is concerned; ``reflection.py``
#: adds the per-protocol builders, headers and usage mapping against the same
#: keys, and a test pins the two key sets together.
PROTOCOL_REQUEST_PATHS: dict[str, str] = {
    "anthropic-messages": "/v1/messages",
    "openai-responses": "/responses",
    "openai-chat": "/chat/completions",
}

SUPPORTED_WIRE_PROTOCOLS: tuple[str, ...] = tuple(PROTOCOL_REQUEST_PATHS)

# JSON field name -> (dataclass field name, required type). The registry JSON is
# camelCase because TypeScript authored it; the dataclass is snake_case because
# Python reads it.
_ENTRY_FIELDS: tuple[tuple[str, str, type], ...] = (
    ("id", "id", str),
    ("protocol", "protocol", str),
    ("baseUrl", "base_url", str),
    ("credentialEnv", "credential_env", str),
    ("authHeader", "auth_header", str),
    ("authValuePrefix", "auth_value_prefix", str),
    ("builtIn", "built_in", bool),
)


class ReflectionProviderError(RuntimeError):
    """A provider transport failure with a stable, operator-visible code.

    Defined here rather than in ``reflection.py`` so the registry loader can
    raise it without importing the transport it is imported by.
    ``orizu_gepa.reflection`` re-exports it, which is where every existing
    caller imports it from.
    """

    def __init__(self, code: str, message: str, *, usage: dict[str, int] | None = None) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.usage = usage


@dataclass(frozen=True)
class ProviderEntry:
    """One registered provider, exactly as the generated JSON declares it."""

    id: str
    protocol: str
    base_url: str
    credential_env: str
    auth_header: str
    auth_value_prefix: str
    built_in: bool


def _registry_resource():
    """The registry JSON as a traversable resource.

    Private test seam: the transport suite points this at a temporary JSON and
    calls ``load_provider_registry.cache_clear()``.

    There is deliberately no ``__file__`` fallback. ``requires-python`` is
    >=3.10, so ``importlib.resources.files`` is always available, and a
    fallback would hide a packaging break that the packed-tarball test in
    ``test/cli-gepa-packaging.test.ts`` exists to catch.
    """
    return importlib.resources.files(REGISTRY_RESOURCE_PACKAGE).joinpath(REGISTRY_RESOURCE_NAME)


def _registry_missing_error(detail: str) -> ReflectionProviderError:
    return ReflectionProviderError(
        "ORI_2032_PROVIDER_REGISTRY_MISSING",
        f"{REGISTRY_RESOURCE_NAME} is missing from the {REGISTRY_RESOURCE_PACKAGE} package: {detail}",
    )


def _parsed_entry(raw: Any, index: int) -> ProviderEntry:
    if not isinstance(raw, dict):
        raise ReflectionProviderError(
            "ORI_2032_PROVIDER_REGISTRY_INVALID",
            f"{REGISTRY_RESOURCE_NAME} providers[{index}] must be an object",
        )
    values: dict[str, Any] = {}
    for json_name, field_name, expected in _ENTRY_FIELDS:
        value = raw.get(json_name)
        # bool is a subclass of int, so check bool first and reject a bool
        # standing in for a string field.
        if expected is bool:
            valid = isinstance(value, bool)
        else:
            valid = isinstance(value, expected) and not isinstance(value, bool)
        if not valid:
            raise ReflectionProviderError(
                "ORI_2032_PROVIDER_REGISTRY_INVALID",
                f"{REGISTRY_RESOURCE_NAME} providers[{index}].{json_name} must be "
                f"{expected.__name__}; received {type(value).__name__}",
            )
        values[field_name] = value
    return ProviderEntry(**values)


@lru_cache(maxsize=1)
def load_provider_registry() -> tuple[ProviderEntry, ...]:
    """Every registered provider, in the order the generated JSON declares."""
    resource = _registry_resource()
    try:
        if not resource.is_file():
            raise _registry_missing_error(f"{resource} is not a file")
        raw_text = resource.read_text(encoding="utf-8")
    except (OSError, ModuleNotFoundError) as error:
        raise _registry_missing_error(str(error)) from error

    try:
        document = json.loads(raw_text)
    except json.JSONDecodeError as error:
        raise ReflectionProviderError(
            "ORI_2032_PROVIDER_REGISTRY_INVALID",
            f"{REGISTRY_RESOURCE_NAME} is not valid JSON: {error}",
        ) from error
    if not isinstance(document, dict):
        raise ReflectionProviderError(
            "ORI_2032_PROVIDER_REGISTRY_INVALID",
            f"{REGISTRY_RESOURCE_NAME} must be a JSON object",
        )

    schema_version = document.get("schemaVersion")
    if schema_version != REGISTRY_SCHEMA_VERSION:
        raise ReflectionProviderError(
            "ORI_2032_PROVIDER_REGISTRY_SCHEMA_UNSUPPORTED",
            f"{REGISTRY_RESOURCE_NAME} declares schemaVersion {schema_version!r}; "
            f"this transport reads {REGISTRY_SCHEMA_VERSION!r}",
        )

    entries = document.get("providers")
    if not isinstance(entries, list):
        raise ReflectionProviderError(
            "ORI_2032_PROVIDER_REGISTRY_INVALID",
            f"{REGISTRY_RESOURCE_NAME} providers must be a list",
        )
    return tuple(_parsed_entry(entry, index) for index, entry in enumerate(entries))


def effective_provider_registry() -> tuple[ProviderEntry, ...]:
    """Merge current hosted metadata without changing the packaged cache seam."""
    packaged = load_provider_registry()
    text = os.environ.get("ORIZU_PROVIDER_REGISTRY_EXTRA")
    if text is None:
        return packaged

    def invalid() -> ReflectionProviderError:
        return ReflectionProviderError("ORI_2032_PROVIDER_REGISTRY_INVALID", "ORIZU_PROVIDER_REGISTRY_EXTRA is invalid")

    try:
        rows = json.loads(text)
    except (ValueError, TypeError):
        raise invalid() from None
    if not isinstance(rows, list):
        raise invalid()
    builtins = {entry.id for entry in packaged}
    ids: set[str] = set()
    envs: set[str] = set()
    extra: list[ProviderEntry] = []
    # provider-refusals.ts is the field/reserved-name source of truth; this laxer backstop needs the ORI-2089 drift test.
    for row in rows:
        if not isinstance(row, dict) or any(not isinstance(row.get(field), str) for field, _, expected in _ENTRY_FIELDS if expected is str):
            raise invalid()
        provider_id = row["id"]
        credential_env = row["credentialEnv"]
        if (not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", provider_id) or provider_id in ids
                or row["protocol"] not in SUPPORTED_WIRE_PROTOCOLS
                or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,58}_API_KEY", credential_env)
                or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", row["authHeader"])
                or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in row["authValuePrefix"])):
            raise invalid()
        try:
            url = urlsplit(row["baseUrl"])
            loopback = url.hostname in ("localhost", "127.0.0.1", "::1")
            if (not url.hostname or url.username or url.password or url.query or url.fragment
                    or (url.scheme != "https" and not (url.scheme == "http" and loopback))):
                raise invalid()
        except ValueError:
            raise invalid() from None
        ids.add(provider_id)
        if provider_id in builtins:
            continue
        if (credential_env in envs or credential_env.startswith("ORIZU_") or credential_env in
                {"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "BRAINTRUST_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"}):
            raise invalid()
        envs.add(credential_env)
        extra.append(ProviderEntry(provider_id, row["protocol"], row["baseUrl"], credential_env,
                                   row["authHeader"], row["authValuePrefix"], False))
    return packaged + tuple(extra)


def registered_provider_ids() -> tuple[str, ...]:
    """Ids of packaged providers followed by current delivered entries."""
    return tuple(entry.id for entry in effective_provider_registry())


def find_provider(provider_id: str | None) -> ProviderEntry | None:
    """Exact id match. No case folding, no prefix matching."""
    if not provider_id:
        return None
    for entry in effective_provider_registry():
        if entry.id == provider_id:
            return entry
    return None


def parse_model_identity(identity: str | None) -> tuple[str | None, str]:
    """Split a model config identity into its provider segment and model id.

    Splits on the FIRST slash and keeps everything after it, so
    ``openrouter/anthropic/claude-x`` keeps its vendor segment. No slash means
    no provider segment. Mirrors the TypeScript ``parseModelIdentity``.
    """
    value = identity or ""
    provider, separator, model_id = value.partition("/")
    if not separator:
        return None, value
    return provider, model_id


def protocol_for_identity(identity: str | None) -> str | None:
    """The wire protocol a model identity's provider speaks, or None.

    Deliberately non-raising: the output-cap rule must stay reachable for an
    unresolved identity, where the cap is required rather than the run failing
    with a registry code before the launch contract is checked.
    """
    provider, _ = parse_model_identity(identity)
    entry = find_provider(provider)
    return entry.protocol if entry else None


def provider_for_identity(identity: str | None) -> ProviderEntry:
    """The registered provider a model identity names.

    Never defaults. Every refusal is named, because the alternative — the
    ``startswith("openai/") else "anthropic"`` rule this replaces — silently
    sent an unknown provider's model to Anthropic with Anthropic's key.
    """
    provider, _ = parse_model_identity(identity)
    if provider is None:
        raise ReflectionProviderError(
            "ORI_2032_MODEL_IDENTITY_NOT_QUALIFIED",
            f"reflection model {identity!r} names no provider; qualify it as "
            f"anthropic/<model id> (the segment before the first slash is the provider)",
        )
    entry = find_provider(provider)
    if entry is None:
        raise ReflectionProviderError(
            "ORI_2032_PROVIDER_UNKNOWN",
            f"provider {provider!r} is not registered; registered providers are "
            f"{', '.join(registered_provider_ids())}",
        )
    if entry.protocol not in PROTOCOL_REQUEST_PATHS:
        raise ReflectionProviderError(
            "ORI_2032_PROTOCOL_UNSUPPORTED",
            f"provider {entry.id!r} speaks wire protocol {entry.protocol!r}, which this "
            f"transport does not implement; it speaks {', '.join(SUPPORTED_WIRE_PROTOCOLS)}",
        )
    return entry


def provider_endpoint(entry: ProviderEntry) -> str:
    """The URL one request is sent to.

    ``base_url`` owns everything up to and including the provider's own version
    segment, and the protocol path (``/v1/messages``, ``/responses``,
    ``/chat/completions``) is appended verbatim. That is why the join looks
    asymmetric: ``https://api.anthropic.com`` + ``/v1/messages`` and
    ``https://api.openai.com/v1`` + ``/responses`` are both exactly what those
    providers document.
    """
    path = PROTOCOL_REQUEST_PATHS.get(entry.protocol)
    if path is None:
        raise ReflectionProviderError(
            "ORI_2032_PROTOCOL_UNSUPPORTED",
            f"wire protocol {entry.protocol!r} has no request path",
        )
    return f"{entry.base_url.rstrip('/')}{path}"


def provider_auth_headers(entry: ProviderEntry, key: str) -> dict[str, str]:
    """The exact auth header bytes a provider expects.

    ``x-api-key: KEY`` for Anthropic and ``Authorization: Bearer KEY`` for the
    OpenAI-shaped providers, which is what this transport already sent.
    """
    return {entry.auth_header: f"{entry.auth_value_prefix}{key}"}
