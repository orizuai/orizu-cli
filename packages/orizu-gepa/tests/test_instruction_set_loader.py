"""ALI-1532 shared on-disk instruction-set loader conformance."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "packages/orizu-gepa/src"))

from orizu_gepa_connector.instruction_set_loader import (
    LEGACY_LOADER_RETIRED,
    InstructionSetLoaderError,
    load_instruction_set,
)


class InstructionSetLoaderConformanceTest(unittest.TestCase):
    """The Python entry point must consume the same fixture as TypeScript."""

    def setUp(self):
        self.fixture_root = REPOSITORY_ROOT / "test/fixtures/instruction-set-conformance"
        self.cases = json.loads((self.fixture_root / "cases.json").read_text())
        self.temp_dir = tempfile.TemporaryDirectory(prefix="orizu-ali1532-loader-")
        shutil.copytree(
            self.fixture_root / self.cases["name"],
            Path(self.temp_dir.name) / self.cases["name"],
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_shared_conformance_cases(self):
        for case in self.cases["cases"]:
            with self.subTest(model_config_identity=case["modelConfigIdentity"]):
                # Mutants killed: production/default misselection, a missing
                # profile refusal, missing-key empty text, and silent Git pins.
                if "expected" in case:
                    self.assertEqual(
                        load_instruction_set(self.temp_dir.name, self.cases["name"], case["modelConfigIdentity"]),
                        case["expected"],
                    )
                else:
                    with self.assertRaises(InstructionSetLoaderError) as ctx:
                        load_instruction_set(self.temp_dir.name, self.cases["name"], case["modelConfigIdentity"])
                    self.assertEqual(ctx.exception.code, case["expectedError"])

    def test_named_future_version_and_missing_sync_errors(self):
        # Mutants killed: future-version acceptance and absent material
        # returning an empty dictionary.
        manifest_path = Path(self.temp_dir.name) / self.cases["name"] / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["manifestVersion"] = 2
        manifest_path.write_text(json.dumps(manifest) + "\n")
        with self.assertRaises(InstructionSetLoaderError) as ctx:
            load_instruction_set(self.temp_dir.name, self.cases["name"], "acme/gpt-5.4")
        self.assertEqual(ctx.exception.code, "instruction_set_manifest_version_unsupported")
        with self.assertRaises(InstructionSetLoaderError) as ctx:
            load_instruction_set(self.temp_dir.name, "missing", "acme/gpt-5.4")
        self.assertEqual(ctx.exception.code, "instruction_set_not_synced")

    def test_fixture_bytes_missing_manifest_and_unsafe_path_are_named(self):
        # Mutants killed: escaped fixture bytes, collapsing an existing set
        # without a manifest into not-synced, or reading outside set root.
        for path in (Path(self.temp_dir.name) / self.cases["name"]).rglob("*.md"):
            self.assertNotIn("\\n", path.read_text())
        (Path(self.temp_dir.name) / self.cases["name"] / "manifest.json").unlink()
        with self.assertRaises(InstructionSetLoaderError) as ctx:
            load_instruction_set(self.temp_dir.name, self.cases["name"], "acme/gpt-5.4")
        self.assertEqual(ctx.exception.code, "instruction_set_manifest_missing")
        shutil.copy2(self.fixture_root / self.cases["name"] / "manifest.json", Path(self.temp_dir.name) / self.cases["name"] / "manifest.json")
        manifest_path = Path(self.temp_dir.name) / self.cases["name"] / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["profiles"][0]["production"]["files"]["system"] = "../escape.md"
        manifest_path.write_text(json.dumps(manifest) + "\n")
        with self.assertRaises(InstructionSetLoaderError) as ctx:
            load_instruction_set(self.temp_dir.name, self.cases["name"], "acme/gpt-5.4")
        self.assertEqual(ctx.exception.code, "instruction_set_path_unsafe")

    def test_refuses_a_symlink_component_that_resolves_outside_the_set(self):
        root = Path(self.temp_dir.name) / self.cases["name"]
        outside = Path(self.temp_dir.name) / "outside.md"
        outside.write_text("outside\n")
        manifest_path = root / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        (root / "profiles" / "acme__gpt-5.4" / "linked.md").symlink_to(outside)
        manifest["profiles"][0]["production"]["files"]["system"] = "profiles/acme__gpt-5.4/linked.md"
        manifest_path.write_text(json.dumps(manifest) + "\n")
        with self.assertRaises(InstructionSetLoaderError) as ctx:
            load_instruction_set(self.temp_dir.name, self.cases["name"], "acme/gpt-5.4")
        self.assertEqual(ctx.exception.code, "instruction_set_path_unsafe")

    def test_names_an_unreadable_component_differently_from_a_pin(self):
        (Path(self.temp_dir.name) / self.cases["name"] / "profiles" / "acme__gpt-5.4" / "system.md").unlink()
        with self.assertRaises(InstructionSetLoaderError) as ctx:
            load_instruction_set(self.temp_dir.name, self.cases["name"], "acme/gpt-5.4")
        self.assertEqual(ctx.exception.code, "instruction_set_component_unreadable")

    def test_refuses_a_paved_tree_addressed_by_display_name(self):
        # Mutant killed: inspect paved directories only by slug-shaped paths.
        version = Path(self.temp_dir.name) / "orizu" / "instruction-sets" / "planner" / "openai__gpt" / "v2"
        version.mkdir(parents=True)
        (version / "manifest.json").write_text(json.dumps({
            "instructionSetName": "Planner Agent",
            "instructionSetSlug": "planner",
        }))
        with self.assertRaises(InstructionSetLoaderError) as ctx:
            load_instruction_set(self.temp_dir.name, "Planner Agent", "openai/gpt")
        self.assertEqual(ctx.exception.code, LEGACY_LOADER_RETIRED)

    def test_loads_directory_written_by_the_built_sync_cli(self):
        """Drive the built public CLI, then load its actual on-disk artifact."""
        payload = {
            "instructionSet": {
                "instructionSetId": "11111111-1111-4111-8111-111111111111",
                "name": "Planner",
                "slug": "planner",
                "defaultProfile": {
                    "modelConfigIdentity": "acme/default",
                    "profileSlug": "acme__default",
                },
                "profile": {
                    "modelConfigIdentity": "acme/default",
                    "profileSlug": "acme__default",
                    "production": "v2",
                },
                "version": {
                    "profileVersionId": "22222222-2222-4222-8222-222222222222",
                    "versionNumber": 2,
                    "components": {
                        "system": {"body": "Default system\n"},
                        "skill": {"body": "Default skill\n"},
                        "tools": {"body": "Default tools\n"},
                    },
                    "settings": {"temperature": 0.2, "max_tokens": 512},
                },
            }
        }

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 - HTTPServer public hook
                if self.path == "/api/cli/teams":
                    body = {"teams": [{"id": "team-1", "name": "Core", "slug": "core"}]}
                elif self.path == "/api/cli/projects?teamSlug=core":
                    body = {"projects": [{"id": "project-1", "name": "Evals", "slug": "evals", "teamSlug": "core"}]}
                elif self.path == "/api/cli/instruction-sets/planner/sync?project=core%2Fevals":
                    body = payload
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                encoded = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def log_message(self, format, *args):
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        output = Path(self.temp_dir.name) / "real-sync"
        try:
            build = subprocess.run(
                ["bun", "run", "build"],
                cwd=REPOSITORY_ROOT / "packages/cli",
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(build.returncode, 0, build.stdout + build.stderr)
            result = subprocess.run(
                [
                    "node", "packages/cli/dist/index.js", "--server", f"http://127.0.0.1:{server.server_port}",
                    "instruction-sets", "sync", "planner", "--project", "core/evals", "--out", str(output), "--json",
                ],
                cwd=REPOSITORY_ROOT,
                env={**os.environ, "ORIZU_TOKEN": "orizu_pat_test"},
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

        version_manifest = json.loads(
            (
                output
                / "orizu/instruction-sets/planner/acme__default/v2/manifest.json"
            ).read_text()
        )
        self.assertEqual(
            version_manifest["settings"],
            {"temperature": 0.2, "max_tokens": 512},
        )

        # Mutants killed: drop required settings from the public payload,
        # collapse the paved tree into generic not-synced, or let the retired
        # loader misinterpret the Version manifest.
        with self.assertRaises(InstructionSetLoaderError) as ctx:
            load_instruction_set(str(output), "planner", "acme/default")
        self.assertEqual(
            ctx.exception.code,
            "instruction_set_legacy_loader_retired: this tree was synced by the paved path; see docs/cli.md#migrating-the-legacy-sync-layout",
        )


if __name__ == "__main__":
    unittest.main()
