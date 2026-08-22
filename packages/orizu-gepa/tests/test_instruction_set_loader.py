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
        manifest["default"]["files"]["system"] = "../escape.md"
        manifest_path.write_text(json.dumps(manifest) + "\n")
        with self.assertRaises(InstructionSetLoaderError) as ctx:
            load_instruction_set(self.temp_dir.name, self.cases["name"], "acme/no-profile")
        self.assertEqual(ctx.exception.code, "instruction_set_path_unsafe")

    def test_refuses_a_symlink_component_that_resolves_outside_the_set(self):
        root = Path(self.temp_dir.name) / self.cases["name"]
        outside = Path(self.temp_dir.name) / "outside.md"
        outside.write_text("outside\n")
        manifest_path = root / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        (root / "default" / "linked.md").symlink_to(outside)
        manifest["default"]["files"]["system"] = "default/linked.md"
        manifest_path.write_text(json.dumps(manifest) + "\n")
        with self.assertRaises(InstructionSetLoaderError) as ctx:
            load_instruction_set(self.temp_dir.name, self.cases["name"], "acme/no-profile")
        self.assertEqual(ctx.exception.code, "instruction_set_path_unsafe")

    def test_names_an_unreadable_component_differently_from_a_pin(self):
        (Path(self.temp_dir.name) / self.cases["name"] / "default" / "system.md").unlink()
        with self.assertRaises(InstructionSetLoaderError) as ctx:
            load_instruction_set(self.temp_dir.name, self.cases["name"], "acme/no-profile")
        self.assertEqual(ctx.exception.code, "instruction_set_component_unreadable")

    def test_loads_directory_written_by_the_built_sync_cli(self):
        """Drive the built public CLI, then load its actual on-disk artifact."""
        payload = json.loads(
            (REPOSITORY_ROOT / "test/fixtures/instruction-set-sync-route-payload.json").read_text()
        )

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

        # Mutants killed: let the writer emit a manifest unreadable by this
        # loader, or turn a pinned component into empty text on disk.
        self.assertEqual(
            load_instruction_set(str(output), "planner", "acme/no-profile"),
            {"system": "Default system\n", "skill": "Default skill\n", "tools": "Default tools\n"},
        )
        with self.assertRaises(InstructionSetLoaderError) as ctx:
            load_instruction_set(str(output), "planner", "acme/gpt-5.4")
        self.assertEqual(ctx.exception.code, "instruction_set_component_unavailable")


if __name__ == "__main__":
    unittest.main()
