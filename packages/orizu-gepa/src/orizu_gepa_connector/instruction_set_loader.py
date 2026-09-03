"""Offline reader for the ALI-1532 synced instruction-set layout."""

import json
import re
from pathlib import Path


LEGACY_LOADER_RETIRED = "instruction_set_legacy_loader_retired: this tree was synced by the paved path; see docs/cli.md#migrating-the-legacy-sync-layout"


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


def _paved_tree_matches_display_name(directory_root: Path, reference: str) -> bool:
    sets_root = directory_root / "orizu" / "instruction-sets"
    try:
        for manifest_path in sets_root.glob("*/*/v*/manifest.json"):
            if not _inside(directory_root, manifest_path.resolve()):
                continue
            try:
                manifest = json.loads(manifest_path.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            if manifest.get("instructionSetName") == reference or manifest.get("instructionSetSlug") == reference:
                return True
    except OSError:
        return False
    return False


def _resolve_set_root(directory: str, reference: str) -> Path:
    directory_root = Path(directory).resolve()
    if not directory_root.is_dir():
        raise InstructionSetLoaderError("instruction_set_not_synced")
    paved_candidates = (
        directory_root / "orizu" / "instruction-sets" / reference,
        directory_root / "instruction-sets" / reference,
    )
    if (
        any(candidate.is_dir() and _inside(directory_root, candidate.resolve()) for candidate in paved_candidates)
        or (not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", reference)
            and _paved_tree_matches_display_name(directory_root, reference))
    ):
        raise InstructionSetLoaderError(LEGACY_LOADER_RETIRED)
    direct = (directory_root / reference).resolve()
    if _inside(directory_root, direct) and direct.is_dir():
        try:
            direct_manifest = json.loads((direct / "manifest.json").read_text())
        except (OSError, json.JSONDecodeError):
            # Preserve the exact-path loader's specific missing/invalid manifest error.
            return direct
        if direct_manifest.get("name") == reference or direct_manifest.get("slug") == reference:
            return direct
    matches: list[Path] = []
    for child in directory_root.iterdir():
        candidate = child.resolve()
        if child.name.startswith(".") or not child.is_dir() or not _inside(directory_root, candidate):
            continue
        try:
            manifest = json.loads((candidate / "manifest.json").read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if manifest.get("name") == reference or manifest.get("slug") == reference:
            matches.append(candidate)
    if len(matches) != 1:
        code = "instruction_set_reference_ambiguous" if len(matches) > 1 else "instruction_set_not_synced"
        raise InstructionSetLoaderError(code)
    return matches[0]


def load_instruction_set(directory: str, name: str, model_config_identity: str) -> dict[str, str]:
    root = _resolve_set_root(directory, name)
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
    profile = next((profile for profile in manifest.get("profiles", []) if profile.get("modelConfigIdentity") == model_config_identity), None)
    if profile is None:
        raise InstructionSetLoaderError("instruction_set_profile_not_found")
    production = profile.get("production")
    if production is None:
        raise InstructionSetLoaderError("instruction_set_profile_not_promoted")
    material = production
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
