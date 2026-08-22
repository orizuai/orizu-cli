"""Offline reader for the ALI-1532 synced instruction-set layout."""

import json
from pathlib import Path


class InstructionSetLoaderError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def load_instruction_set(directory: str, name: str, model_config_identity: str) -> dict[str, str]:
    root = (Path(directory) / name).resolve()
    if not root.is_dir():
        raise InstructionSetLoaderError("instruction_set_not_synced")
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise InstructionSetLoaderError("instruction_set_manifest_missing")
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise InstructionSetLoaderError("instruction_set_manifest_missing") from error
    if manifest.get("manifestVersion") != 1:
        raise InstructionSetLoaderError("instruction_set_manifest_version_unsupported")
    if manifest.get("filteredTo") and model_config_identity not in manifest["filteredTo"]:
        raise InstructionSetLoaderError("instruction_set_profile_not_synced")
    production = next((profile.get("production") for profile in manifest.get("profiles", []) if profile.get("modelConfigIdentity") == model_config_identity), None)
    material = production or manifest.get("default", {})
    values: dict[str, str] = {}
    for key in manifest.get("shape", []):
        if key in material.get("pinnedComponents", {}):
            raise InstructionSetLoaderError("instruction_set_component_unavailable")
        relative = material.get("files", {}).get(key)
        if not relative:
            raise InstructionSetLoaderError("instruction_set_profile_key_missing")
        path = (root / relative).resolve()
        if not _inside(root, path):
            raise InstructionSetLoaderError("instruction_set_path_unsafe")
        try:
            values[key] = path.read_text()
        except OSError as error:
            raise InstructionSetLoaderError("instruction_set_component_unreadable") from error
    return values
