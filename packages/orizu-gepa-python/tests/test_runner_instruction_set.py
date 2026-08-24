from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from orizu_gepa.optimizer import DatasetRow, PromptContext, RunnerCallResult
from orizu_gepa.runner import ALLOWED_RUNNER_ENV_KEYS, _slug, _write_instruction_set_layout, make_candidate_runner, make_scorer_runner, run_file_contract_runner

LEGACY_BODY = (Path(__file__).resolve().parents[3] / "test/fixtures/ali1535-set-of-one-prompt-body.txt").read_text(encoding="utf-8")
PATH_CONTRACT = json.loads((Path(__file__).resolve().parents[3] / "test/fixtures/ali1535-path-contract.json").read_text(encoding="utf-8"))

MULTI_COMPONENT_SET = {
    "name": "planner",
    "model_config": {
        "identity": "openai/gpt-5.4",
        "settings": {"provider": "openai", "model": "gpt-5.4", "temperature": 0},
    },
    "shape": ["system", "tools"],
    "profile_version_id": "profile-version-2",
    "version_number": 2,
    "components": {
        "system": "System bytes\n",
    },
    "pinned_components": {
        "tools": {"repoPath": "skills/tools.md", "contentSha": "a" * 64, "commitSha": "b" * 40},
    },
}


class RunnerInstructionSetContractTests(unittest.TestCase):
    def test_candidate_runner_substitutes_every_multi_component_candidate_value(self):
        """Mutant killed: evaluate only the first tuple component or rewrite the prompt key."""
        multi = {
            "name": "planner",
            "model_config": {"identity": "openai/gpt-5.4", "settings": {}},
            "shape": ["system", "tools"],
            "profile_version_id": "profile-version-2",
            "version_number": 2,
            "components": {"system": "seed system", "tools": "seed tools"},
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            runner_dir = Path(temp_dir)
            (runner_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}), encoding="utf-8")
            (runner_dir / "runner.py").write_text(
                "import json, os\nfrom pathlib import Path\n"
                "root = Path(os.environ['ORIZU_INSTRUCTION_SET_DIR']) / 'planner' / 'default'\n"
                "payload = json.loads(Path(os.environ['ORIZU_RUNNER_INPUT_PATH']).read_text(encoding='utf-8'))\n"
                "Path(os.environ['ORIZU_RUNNER_OUTPUT_PATH']).write_text(json.dumps({'model_response': {'components': payload['instruction_set']['components'], 'layout': {key: (root / f'{key}.md').read_text(encoding='utf-8') for key in ('system', 'tools')}, 'has_body': 'body' in payload['prompt']}, 'error': None}), encoding='utf-8')\n",
                encoding="utf-8",
            )
            candidate_runner = make_candidate_runner(runner_dir, None)
            result = candidate_runner(
                {"system": "new system", "tools": "new tools"},
                DatasetRow(id="row-1", row={"id": "row-1"}),
                PromptContext(body=None, body_kind="text", provider_settings={}, prompt_version_id="prompt-version-1", runner_version_id="runner-version-1", instruction_set=multi, body_present=False),
                "candidate-1",
            )

        self.assertEqual(result.model_response, {
            "components": {"system": "new system", "tools": "new tools"},
            "layout": {"system": "new system", "tools": "new tools"},
            "has_body": False,
        })

    def test_candidate_runner_overlays_candidate_bytes_into_the_named_component(self):
        """Mutant killed: forward the seed instruction set without the candidate overlay."""
        single = {
            "name": "legacy",
            "model_config": {"identity": "openai/gpt-5.4", "settings": {}},
            "shape": ["prompt"],
            "profile_version_id": "profile-version-1",
            "version_number": 1,
            "prompt_component_key": "prompt",
            "components": {"prompt": "seed bytes"},
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            runner_dir = Path(temp_dir)
            (runner_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}), encoding="utf-8")
            (runner_dir / "runner.py").write_text(
                "import json, os\nfrom pathlib import Path\n"
                "root = Path(os.environ['ORIZU_INSTRUCTION_SET_DIR'])\n"
                "payload = json.loads(Path(os.environ['ORIZU_RUNNER_INPUT_PATH']).read_text(encoding='utf-8'))\n"
                "Path(os.environ['ORIZU_RUNNER_OUTPUT_PATH']).write_text(json.dumps({'model_response': {'component': payload['instruction_set']['components']['prompt'], 'layout': (root / 'legacy' / 'default' / 'prompt.md').read_text(encoding='utf-8')}, 'error': None}), encoding='utf-8')\n",
                encoding="utf-8",
            )
            candidate_runner = make_candidate_runner(runner_dir, None)
            result = candidate_runner(
                "candidate bytes",
                DatasetRow(id="row-1", row={"id": "row-1"}),
                PromptContext(body="seed bytes", body_kind="text", provider_settings={}, prompt_version_id="prompt-version-1", runner_version_id="runner-version-1", instruction_set=single),
                "candidate-1",
            )
        self.assertEqual(result.model_response, {"component": "candidate bytes", "layout": "candidate bytes"})

    def test_candidate_runner_accepts_an_implicit_candidate_key_covered_only_by_a_pin(self):
        """Mutant Q3 killed: validate candidate keys against mutable components but not pins."""
        instruction_set = {
            "name": "legacy", "model_config": {"identity": "openai/gpt-5.4", "settings": {}},
            "shape": ["tools", "system"], "profile_version_id": "profile-version-1", "version_number": 1,
            "prompt_component_key": "system",
            "components": {"tools": "seed tools"},
            "pinned_components": {"system": {"repoPath": "system.md", "contentSha": "a" * 64, "commitSha": "b" * 40}},
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            runner_dir = Path(temp_dir)
            (runner_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}), encoding="utf-8")
            (runner_dir / "runner.py").write_text(
                "import json, os\nfrom pathlib import Path\n"
                "payload=json.loads(Path(os.environ['ORIZU_RUNNER_INPUT_PATH']).read_text())\n"
                "Path(os.environ['ORIZU_RUNNER_OUTPUT_PATH']).write_text(json.dumps({'model_response': payload['instruction_set']['components'], 'error': None}))\n",
                encoding="utf-8",
            )
            result = make_candidate_runner(runner_dir, None)(
                "implicit replacement", DatasetRow(id="row", row={}),
                PromptContext(body="implicit replacement", body_kind="text", provider_settings={}, prompt_version_id="prompt", runner_version_id="runner", instruction_set=instruction_set),
                "candidate",
            )
        self.assertEqual(result.model_response, {"tools": "seed tools", "system": "implicit replacement"})

    def test_scorer_runner_forwards_the_tuple_and_layout_to_its_subprocess(self):
        """Mutant killed: omit scorer_context.instruction_set from extra payload."""
        with tempfile.TemporaryDirectory() as temp_dir:
            runner_dir = Path(temp_dir)
            (runner_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}), encoding="utf-8")
            (runner_dir / "runner.py").write_text(
                "import json, os\nfrom pathlib import Path\n"
                "payload = json.loads(Path(os.environ['ORIZU_RUNNER_INPUT_PATH']).read_text(encoding='utf-8'))\n"
                "root = Path(os.environ['ORIZU_INSTRUCTION_SET_DIR'])\n"
                "Path(os.environ['ORIZU_RUNNER_OUTPUT_PATH']).write_text(json.dumps({'model_response': {'component': payload['instruction_set']['components']['system'], 'layout': (root / 'planner' / 'default' / 'system.md').read_text(encoding='utf-8')}, 'error': None}), encoding='utf-8')\n",
                encoding="utf-8",
            )
            scorer_runner = make_scorer_runner(runner_dir, None)
            result = scorer_runner(
                DatasetRow(id="row-1", row={"id": "row-1"}),
                RunnerCallResult(model_response="candidate output"),
                PromptContext(body="judge", body_kind="text", provider_settings={}, prompt_version_id="scorer-prompt-version-1", runner_version_id="scorer-runner-version-1", instruction_set=MULTI_COMPONENT_SET),
                "candidate-1",
            )
        self.assertEqual(result.model_response, {"component": "System bytes\n", "layout": "System bytes\n"})

    def test_runner_subprocess_receives_the_tuple_and_an_isolated_synced_layout(self):
        """Mutants killed: drop route body, share row dirs, invent pins, or widen env."""
        self.assertEqual(ALLOWED_RUNNER_ENV_KEYS, {
            "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "HOME", "LANG",
            "LC_ALL", "NODE_PATH", "OPENAI_API_KEY", "PATH", "PYTHONPATH", "SystemRoot",
            "TEMP", "TMP", "TMPDIR", "WINDIR",
        })
        original_should_not_leak = os.environ.get("ORIZU_SHOULD_NOT_LEAK")
        os.environ["ORIZU_SHOULD_NOT_LEAK"] = "must-not-reach-runner"
        with tempfile.TemporaryDirectory() as temp_dir:
            runner_dir = Path(temp_dir)
            (runner_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}))
            (runner_dir / "runner.py").write_text(
                """
import json
import os
from pathlib import Path

input_path = Path(os.environ["ORIZU_RUNNER_INPUT_PATH"])
instruction_root = Path(os.environ["ORIZU_INSTRUCTION_SET_DIR"])
marker = instruction_root / "row-marker"
was_shared = marker.exists()
marker.write_text("seen")
output = {
    "model_response": {
        "input_bytes": input_path.read_text(),
        "orizu_keys": sorted(key for key in os.environ if key.startswith("ORIZU_")),
        "was_shared": was_shared,
        "has_leaked_ambient": "ORIZU_SHOULD_NOT_LEAK" in os.environ,
        "manifest": json.loads((instruction_root / "planner" / "manifest.json").read_text()),
        "pinned_file_exists": (instruction_root / "planner" / "default" / "tools.md").exists(),
    },
    "error": None,
}
Path(os.environ["ORIZU_RUNNER_OUTPUT_PATH"]).write_text(json.dumps(output))
"""
            )

            first = run_file_contract_runner(
                runner_dir=runner_dir,
                row={"id": "row-1"},
                prompt_body="legacy prompt bytes\n",
                body_kind="text",
                provider_settings=MULTI_COMPONENT_SET["model_config"]["settings"],
                prompt_version_id="prompt-version-1",
                runner_version_id="runner-version-1",
                run_id="run-1",
                extra_payload={"instruction_set": MULTI_COMPONENT_SET},
            )
            second = run_file_contract_runner(
                runner_dir=runner_dir,
                row={"id": "row-2"},
                prompt_body="legacy prompt bytes\n",
                body_kind="text",
                provider_settings=MULTI_COMPONENT_SET["model_config"]["settings"],
                prompt_version_id="prompt-version-1",
                runner_version_id="runner-version-1",
                run_id="run-1",
                extra_payload={"instruction_set": MULTI_COMPONENT_SET},
            )

        for result in (first, second):
            observed = result.model_response
            self.assertEqual(observed["orizu_keys"], [
                "ORIZU_INSTRUCTION_SET_DIR",
                "ORIZU_RUNNER_INPUT_PATH",
                "ORIZU_RUNNER_OUTPUT_PATH",
            ])
            self.assertFalse(observed["was_shared"])
            self.assertFalse(observed["has_leaked_ambient"])
            self.assertFalse(observed["pinned_file_exists"])
            self.assertEqual(observed["manifest"]["name"], "planner")
            self.assertEqual(observed["manifest"]["shape"], ["system", "tools"])
            payload = json.loads(observed["input_bytes"])
            self.assertEqual(payload["instruction_set"], {
                "name": "planner",
                "model_config": MULTI_COMPONENT_SET["model_config"],
                "shape": ["system", "tools"],
                "components": MULTI_COMPONENT_SET["components"],
                "pinned_components": MULTI_COMPONENT_SET["pinned_components"],
            })
            self.assertEqual(payload["prompt"]["body"], "legacy prompt bytes\n")
        if original_should_not_leak is None:
            os.environ.pop("ORIZU_SHOULD_NOT_LEAK", None)
        else:
            os.environ["ORIZU_SHOULD_NOT_LEAK"] = original_should_not_leak

    def test_set_of_one_keeps_the_pinned_legacy_body_bytes(self):
        """Mutant killed: remove or normalize prompt.body for a one-component instruction set."""
        single = {
            "name": "legacy",
            "model_config": {"identity": "openai/gpt-5.4", "settings": {}},
            "shape": ["prompt"],
            "profile_version_id": "profile-version-1",
            "version_number": 1,
            "components": {"prompt": LEGACY_BODY},
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            runner_dir = Path(temp_dir)
            (runner_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}))
            (runner_dir / "runner.py").write_text(
                "import json, os\nfrom pathlib import Path\n"
                "instruction_root = Path(os.environ['ORIZU_INSTRUCTION_SET_DIR'])\n"
                "raw = Path(os.environ['ORIZU_RUNNER_INPUT_PATH']).read_text()\n"
                "Path(os.environ['ORIZU_RUNNER_OUTPUT_PATH']).write_text(json.dumps({'model_response': raw, 'error': None}))\n"
            )
            result = run_file_contract_runner(
                runner_dir=runner_dir, row={"id": "row-1"}, prompt_body=LEGACY_BODY,
                body_kind="text", provider_settings={}, prompt_version_id="prompt-version-1",
                runner_version_id="runner-version-1", run_id=None, extra_payload={"instruction_set": single},
            )

        self.assertEqual(json.loads(result.model_response)["prompt"]["body"], LEGACY_BODY)

    def test_mirrors_an_explicit_multi_component_response_without_prompt_body(self):
        """Mutant killed: re-add body after the server deliberately omitted it."""
        with tempfile.TemporaryDirectory() as temp_dir:
            runner_dir = Path(temp_dir)
            (runner_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}), encoding="utf-8")
            (runner_dir / "runner.py").write_text(
                "import json, os\nfrom pathlib import Path\n"
                "raw = Path(os.environ['ORIZU_RUNNER_INPUT_PATH']).read_text(encoding='utf-8')\n"
                "Path(os.environ['ORIZU_RUNNER_OUTPUT_PATH']).write_text(json.dumps({'model_response': raw, 'error': None}), encoding='utf-8')\n",
                encoding="utf-8",
            )
            result = run_file_contract_runner(
                runner_dir=runner_dir, row={"id": "row-1"}, prompt_body=None,
                prompt_body_present=False, body_kind="text", provider_settings={},
                prompt_version_id="prompt-version-1", runner_version_id="runner-version-1",
                run_id=None, extra_payload={"instruction_set": MULTI_COMPONENT_SET},
            )
        self.assertNotIn("body", json.loads(result.model_response)["prompt"])

    def test_drops_an_ambient_instruction_set_directory_without_a_tuple(self):
        """Mutant killed: inherit ORIZU_INSTRUCTION_SET_DIR without an exact tuple."""
        original = os.environ.get("ORIZU_INSTRUCTION_SET_DIR")
        os.environ["ORIZU_INSTRUCTION_SET_DIR"] = "/ambient/never-pass-this"
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                runner_dir = Path(temp_dir)
                (runner_dir / "manifest.json").write_text(json.dumps({"command": [sys.executable, "runner.py"]}), encoding="utf-8")
                (runner_dir / "runner.py").write_text(
                    "import json, os\nfrom pathlib import Path\n"
                    "Path(os.environ['ORIZU_RUNNER_OUTPUT_PATH']).write_text(json.dumps({'model_response': {'has_instruction_set_dir': 'ORIZU_INSTRUCTION_SET_DIR' in os.environ}, 'error': None}))\n",
                    encoding="utf-8",
                )
                result = run_file_contract_runner(
                    runner_dir=runner_dir, row={"id": "row-1"}, prompt_body="legacy",
                    body_kind="text", provider_settings={}, prompt_version_id="prompt-version-1",
                    runner_version_id="runner-version-1", run_id=None,
                )
            self.assertFalse(result.model_response["has_instruction_set_dir"])
        finally:
            if original is None:
                os.environ.pop("ORIZU_INSTRUCTION_SET_DIR", None)
            else:
                os.environ["ORIZU_INSTRUCTION_SET_DIR"] = original

    def test_refuses_unsafe_layout_segments_before_writing(self):
        """Mutants killed: accept traversal, dotfile, or absolute server names."""
        for unsafe in PATH_CONTRACT["unsafeSegments"]:
            for name, shape in ((unsafe, ["system"]), ("planner", [unsafe])):
                with tempfile.TemporaryDirectory() as temp_dir:
                    payload = {**MULTI_COMPONENT_SET, "name": name, "shape": shape, "components": {shape[0]: "text"}, "pinned_components": {}}
                    with self.assertRaisesRegex(RuntimeError, "instruction_set_path_unsafe"):
                        _write_instruction_set_layout(Path(temp_dir) / "instruction-set", payload)
                    self.assertEqual(list(Path(temp_dir).rglob("*")), [])
        for identity in PATH_CONTRACT["unsafeIdentities"]:
            with tempfile.TemporaryDirectory() as temp_dir:
                payload = {**MULTI_COMPONENT_SET, "model_config": {"identity": identity}}
                with self.assertRaisesRegex(RuntimeError, "instruction_set_path_unsafe"):
                    _write_instruction_set_layout(Path(temp_dir) / "instruction-set", payload)
                self.assertEqual(list(Path(temp_dir).rglob("*")), [])

    def test_uses_the_shared_typescript_slug_cases(self):
        """Mutant killed: Python's model identity slug differs from syncToDisk."""
        for identity, expected_slug in PATH_CONTRACT["slugCases"]:
            self.assertEqual(_slug(identity), expected_slug)

    def test_refuses_a_partial_tuple_with_its_named_error(self):
        """Mutant killed: treat a missing shape component as an empty body."""
        with tempfile.TemporaryDirectory() as temp_dir:
            with self.assertRaisesRegex(RuntimeError, "instruction_set_tuple_incomplete"):
                _write_instruction_set_layout(Path(temp_dir) / "instruction-set", {
                    **MULTI_COMPONENT_SET,
                    "pinned_components": {},
                })

    def test_writes_component_text_as_utf8_bytes(self):
        """Mutant killed: use the host encoding for synced component text."""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "instruction-set"
            payload = {**MULTI_COMPONENT_SET, "components": {"system": "héllo 🤖"}, "pinned_components": {"tools": MULTI_COMPONENT_SET["pinned_components"]["tools"]}}
            _write_instruction_set_layout(root, payload)
            self.assertEqual((root / "planner" / "default" / "system.md").read_bytes(), "héllo 🤖".encode("utf-8"))

    def test_writes_typescript_authoring_paths_and_hashes_from_file_bytes(self):
        """Mutants killed: emit a wrong authoring path or hash pre-write text instead of written bytes."""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "instruction-set"
            _write_instruction_set_layout(root, MULTI_COMPONENT_SET)
            destination = root / "planner"
            manifest = json.loads((destination / "manifest.json").read_text(encoding="utf-8"))

            expected_paths = {
                (None, "system"): "default/system.md",
                ("openai/gpt-5.4", "system"): "profiles/openai__gpt-5.4/system.md",
            }
            observed_components = {
                (component.get("modelConfig"), component["key"]): component
                for component in manifest["components"]
            }
            self.assertEqual(set(observed_components), set(expected_paths))

            for component_identity_and_key, relative_path in expected_paths.items():
                component = observed_components[component_identity_and_key]
                written_path = destination / relative_path
                written_hash = hashlib.sha256(written_path.read_bytes()).hexdigest()
                self.assertEqual(component["path"], relative_path)
                self.assertEqual(component["syncedContentSha256"], written_hash)

            expected_hash = hashlib.sha256("System bytes\n".encode("utf-8")).hexdigest()
            self.assertEqual(manifest["default"]["files"], {"system": "default/system.md"})
            self.assertEqual(manifest["default"]["syncedContentSha256"], {"system": expected_hash})
            self.assertEqual(manifest["profiles"][0]["production"]["files"], {
                "system": "profiles/openai__gpt-5.4/system.md",
            })
            self.assertEqual(manifest["profiles"][0]["production"]["syncedContentSha256"], {
                "system": expected_hash,
            })

    def test_all_pinned_tuple_writes_manifest_without_component_files(self):
        """Mutant killed: create the destination only as a side effect of inline text."""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "instruction-set"
            payload = {**MULTI_COMPONENT_SET, "components": {}, "pinned_components": {
                "system": {"repoPath": "system.md", "contentSha": "c" * 64, "commitSha": "d" * 40},
                "tools": {"repoPath": "tools.md", "contentSha": "a" * 64, "commitSha": "b" * 40},
            }}
            _write_instruction_set_layout(root, payload)
            manifest = json.loads((root / "planner" / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(set(manifest["default"]["pinnedComponents"]), {"system", "tools"})
            self.assertFalse((root / "planner" / "default" / "system.md").exists())


if __name__ == "__main__":
    unittest.main()
