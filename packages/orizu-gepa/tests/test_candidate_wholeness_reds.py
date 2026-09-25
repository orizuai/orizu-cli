"""ORI-2027 / ORI-2030 red set: candidates stay whole, every reflection is logged.

Hazards (see TESTING.md):

* H1  a candidate longer than ``max_payload_chars`` reaches the dashboard and
  the local log with ``…[truncated]`` in place of its text, so the prompt that
  was actually evaluated can never be read back or promoted faithfully;
* H1b the translator bounds candidate components while sample outputs, which
  are the thing the cap exists for, pass through unbounded;
* H2  under ``--component-selector all`` only one of N reflections survives in
  ``reflections.jsonl`` and the wire event, and the one surviving prompt is the
  last component's prompt attributed to a different component;
* H3  a rejected proposal receives the old truncating treatment because the
  rejection path is a second copy of the acceptance path.

The tests drive the real ``OrizuCallback`` (and, for H1, the real
``MandatoryEventSink`` with a real ``LocalOptimizationLogger``) with real
``gepa==0.1.4`` callback shapes; for H2 the real GEPA loop and the real
``GepaReflectionLM`` produce the per-component proposal.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from orizu_gepa.local_log import LocalOptimizationLogger
from orizu_gepa.optimizer import TextGepaConfig
from orizu_gepa_connector.callbacks import LifecycleHooks, OrizuCallback
from orizu_gepa_connector.engine import run_official_gepa
from orizu_gepa_connector.reflection import make_gepa_reflection_lm
from orizu_gepa_connector.runtime import MandatoryEventSink
from orizu_gepa_connector.stop_conditions import IterationBoundaryStopper
from orizu_gepa_connector.translator import translate_callback

from test_gepa_engine_reds import RUN_ID, DeterministicAdapter, DurableRecordingClient, RecordingSink

MARKER = "…[truncated]"
LONG_CANDIDATE = "candidate text that is forty chars long!"  # 40 chars
LONG_RESPONSE = "response text that is forty chars long!!"  # 40 chars
LONG_OUTPUT = "sample output that is forty chars long!!"  # 40 chars
LONG_PROMPT = "provider prompt that is forty chars long"  # 40 chars
assert len(LONG_CANDIDATE) == len(LONG_RESPONSE) == len(LONG_OUTPUT) == len(LONG_PROMPT) == 40


def _jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines()]


class CandidateWholenessRedContracts(unittest.TestCase):
    def test_accepted_candidate_stays_whole_on_the_wire_and_in_the_local_log_under_the_cap(self):
        """H1. Kills: re-adding bounding to candidate components/body/candidate_text;
        dropping the bound on the reflection response (the cap must still bite somewhere);
        writing the bounded wire prompt instead of the raw provider prompt to the local log."""
        client = DurableRecordingClient()
        with tempfile.TemporaryDirectory() as root:
            logger = LocalOptimizationLogger.create(root, RUN_ID)
            sink = MandatoryEventSink(client, RUN_ID, logger)
            callback = OrizuCallback(sink, RUN_ID, max_payload_chars=8)
            callback.on_candidate_selected({"iteration": 1, "candidate_idx": 0})
            callback.on_proposal_start({"iteration": 1, "components": ["prompt"], "parent_candidate": {"prompt": "seed"}})
            callback.on_proposal_end({
                "iteration": 1, "new_instructions": {"prompt": LONG_CANDIDATE},
                "prompts": {"prompt": LONG_PROMPT}, "raw_lm_outputs": {"prompt": LONG_RESPONSE},
            })
            callback.on_candidate_accepted({"iteration": 1, "new_candidate_idx": 1, "new_score": 0.9, "parent_ids": [0]})
            local_events = _jsonl(Path(root) / RUN_ID / "events.jsonl")
            reflections = _jsonl(Path(root) / RUN_ID / "reflections.jsonl")

        wire = {event["event_type"]: event["payload"] for event in client.events}
        proposed = wire["candidate_proposed"]
        self.assertEqual(proposed["components"], {"prompt": LONG_CANDIDATE})
        self.assertEqual(proposed["body"], LONG_CANDIDATE)
        self.assertNotEqual(proposed.get("payload_truncated"), True)
        local_proposed = next(event for event in local_events if event["event_type"] == "candidate_proposed")["payload"]
        self.assertEqual(local_proposed["components"], {"prompt": LONG_CANDIDATE})
        self.assertEqual(local_proposed["body"], LONG_CANDIDATE)

        reflection = wire["reflection_completed"]
        self.assertEqual(reflection["candidate_text"], LONG_CANDIDATE)
        self.assertEqual(reflection["components"], {"prompt": LONG_CANDIDATE})
        # The cap is for provider material, and it must still bite there.
        self.assertEqual(reflection["response"], LONG_RESPONSE[:8] + MARKER)
        self.assertTrue(reflection["payload_truncated"])
        self.assertIn("response", reflection["truncation"]["fields"])
        self.assertFalse(any(key.startswith("components.") for key in reflection["truncation"]["fields"]))

        self.assertEqual(len(reflections), 1)
        self.assertEqual(reflections[0]["candidate_text"], LONG_CANDIDATE)
        self.assertEqual(reflections[0]["response"], LONG_RESPONSE)
        # The local log is the whole record: the prompt is never the bounded wire copy.
        self.assertEqual(reflections[0]["prompt"], LONG_PROMPT)
        self.assertNotIn("prompt", reflection)
        self.assertEqual(reflections[0]["child_candidate_id"], "1")

    def test_translator_keeps_seed_and_validation_components_whole_and_bounds_row_outputs(self):
        """H1b. Kills: passing the cap into ``_components``; leaving row-result
        ``output`` unbounded; reporting ``components.*`` in ``truncation.fields``."""
        started = translate_callback("on_optimization_start", {
            "seed_candidate": {"prompt": LONG_CANDIDATE, "tools": LONG_CANDIDATE},
            "trainset_size": 1, "valset_size": 1, "config": {},
        }, run_id=RUN_ID, max_payload_chars=8)
        self.assertEqual(started["eventType"], "run_started")
        self.assertEqual(started["payload"]["seed_components"], {"prompt": LONG_CANDIDATE, "tools": LONG_CANDIDATE})
        self.assertEqual(started["payload"]["seed_candidate_text"], LONG_CANDIDATE)
        self.assertNotIn("payload_truncated", started["payload"])
        self.assertNotIn("truncation", started["payload"])

        validated = translate_callback("on_valset_evaluated", {
            "iteration": 1, "candidate_idx": 1, "candidate": {"prompt": LONG_CANDIDATE},
            "scores_by_val_id": {"validation-row-1": 1.0}, "average_score": 1.0,
            "num_examples_evaluated": 1, "total_valset_size": 1, "parent_ids": [], "is_best_program": True,
            "outputs_by_val_id": {"validation-row-1": {"row_id": "canonical-row", "output": LONG_OUTPUT}},
        }, run_id=RUN_ID, max_payload_chars=8)
        self.assertEqual(validated["eventType"], "child_val_set_completed")
        self.assertEqual(validated["payload"]["components"], {"prompt": LONG_CANDIDATE})
        self.assertEqual(validated["payload"]["row_results"][0]["output"], LONG_OUTPUT[:8] + MARKER)
        self.assertTrue(validated["payload"]["payload_truncated"])
        self.assertEqual(validated["payload"]["truncation"]["fields"], {"row_results.canonical-row.output": 40})

    def test_all_selector_reflection_logs_one_row_per_component_with_its_own_prompt(self):
        """H2. Kills: one ``reflections.jsonl`` row per iteration; the last component's
        provider prompt reused for every row; dropping the per-component ``responses`` map."""
        import orizu_gepa_connector.reflection as reflection

        class BridgeAdapter(DeterministicAdapter):
            propose_new_texts = None

        def provider(parent, rows, config):
            return SimpleNamespace(
                response=f"better {parent}", prompt=f"provider prompt for {parent}",
                usage={"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
            )

        seed = {"system": "seed system", "tools": "seed tools", "style": "seed style"}
        with tempfile.TemporaryDirectory() as root:
            logger = LocalOptimizationLogger.create(root, RUN_ID)
            sink = RecordingSink(); sink.local_logger = logger
            callback = OrizuCallback(sink, RUN_ID, log_row_snapshots=True)
            lm = make_gepa_reflection_lm(
                context_supplier=lambda: (seed, []),
                config=TextGepaConfig(reflection_model="openai/test", reflection_max_tokens=1),
                success_reporter=callback.record_reflection_prompt,
            )
            with patch.object(reflection, "reflect_with_provider", side_effect=provider):
                run_official_gepa(
                    seed_candidate=dict(seed), trainset=[{"id": "train"}], valset=[{"id": "validation"}],
                    adapter=BridgeAdapter(), callback=callback, hooks=LifecycleHooks(), reflection_lm=lm,
                    stop_callbacks=[IterationBoundaryStopper(max_iterations=1)], allow_degenerate_seed=True,
                    module_selector="all",
                )
            rows = _jsonl(Path(root) / RUN_ID / "reflections.jsonl")

        self.assertEqual(sorted(row["component"] for row in rows), ["style", "system", "tools"])
        for row in rows:
            component = row["component"]
            self.assertEqual(row["prompt"], f"provider prompt for {seed[component]}", component)
            self.assertEqual(row["response"], f"better {seed[component]}", component)
            self.assertEqual(row["candidate_text"], f"better {seed[component]}", component)
            self.assertEqual(row["iteration"], 1)
            self.assertEqual(row["parent_candidate_id"], "0")
        self.assertEqual(len({row["child_candidate_id"] for row in rows}), 1)

        completed = [event for event in sink.events if event["event_type"] == "reflection_completed"]
        self.assertEqual(len(completed), 1)
        payload = completed[0]["payload"]
        self.assertEqual(payload["responses"], {key: f"better {value}" for key, value in seed.items()})
        self.assertEqual(payload["prompts"], {key: f"provider prompt for {value}" for key, value in seed.items()})
        self.assertIn(payload["response"], payload["responses"].values())

    def test_reflection_completed_redacts_per_component_prompts_unless_row_snapshots_are_logged(self):
        """H2 policy. Kills: shipping the per-component prompt map in clear text under the default policy."""
        sink = RecordingSink()
        callback = OrizuCallback(sink, RUN_ID)
        callback.on_candidate_selected({"iteration": 1, "candidate_idx": 0})
        callback.on_proposal_start({"iteration": 1, "components": ["a", "b"], "parent_candidate": {"a": "A", "b": "B"}})
        callback.on_proposal_end({
            "iteration": 1, "new_instructions": {"a": "A2", "b": "B2"},
            "prompts": {"a": "secret a", "b": "secret b"}, "raw_lm_outputs": {"a": "ra", "b": "rb"},
        })
        callback.on_candidate_accepted({"iteration": 1, "new_candidate_idx": 1, "new_score": 0.9, "parent_ids": [0]})
        payload = next(event for event in sink.events if event["event_type"] == "reflection_completed")["payload"]
        self.assertNotIn("prompt", payload)
        self.assertNotIn("prompts", payload)
        self.assertTrue(payload["prompts_redacted"])
        self.assertIn("prompts_sha256", payload)
        self.assertEqual(payload["responses"], {"a": "ra", "b": "rb"})
        self.assertNotIn("secret", json.dumps(payload))

    def test_rejected_candidate_stays_whole_and_logs_every_component_reflection(self):
        """H3. Kills: a rejection path that still bounds components, or that writes one reflection row."""
        with tempfile.TemporaryDirectory() as root:
            logger = LocalOptimizationLogger.create(root, RUN_ID)
            sink = RecordingSink(); sink.local_logger = logger
            callback = OrizuCallback(sink, RUN_ID, max_payload_chars=8, log_row_snapshots=True)
            callback.on_candidate_selected({"iteration": 3, "candidate_idx": 0})
            callback.on_proposal_start({"iteration": 3, "components": ["a", "b"], "parent_candidate": {"a": "A", "b": "B"}})
            callback.record_reflection_prompt("provider prompt a", component="a")
            callback.record_reflection_prompt("provider prompt b", component="b")
            callback.on_proposal_end({
                "iteration": 3, "new_instructions": {"a": LONG_CANDIDATE, "b": LONG_CANDIDATE.upper()},
                "prompts": {"a": "gepa a", "b": "gepa b"}, "raw_lm_outputs": {"a": "worse a", "b": "worse b"},
            })
            callback.on_candidate_rejected({"iteration": 3, "old_score": 0.2, "new_score": 0.1, "reason": "worse"})
            rows = _jsonl(Path(root) / RUN_ID / "reflections.jsonl")

        proposed = next(event for event in sink.events if event["event_type"] == "candidate_proposed")
        self.assertEqual(proposed["candidate_id"], "rejected-3")
        self.assertEqual(proposed["payload"]["components"], {"a": LONG_CANDIDATE, "b": LONG_CANDIDATE.upper()})
        self.assertNotEqual(proposed["payload"].get("payload_truncated"), True)
        self.assertEqual([row["component"] for row in rows], ["a", "b"])
        self.assertEqual([row["prompt"] for row in rows], ["provider prompt a", "provider prompt b"])
        self.assertEqual([row["response"] for row in rows], ["worse a", "worse b"])
        self.assertEqual([row["candidate_text"] for row in rows], [LONG_CANDIDATE, LONG_CANDIDATE.upper()])
        self.assertEqual({row["child_candidate_id"] for row in rows}, {"rejected-3"})

    def test_reflection_row_is_written_for_a_component_missing_from_raw_lm_outputs(self):
        """H2 drift guard. Kills: taking the row component list from ``raw_lm_outputs`` keys only,
        which silently drops a component GEPA rewrote but for which it recorded no raw output."""
        with tempfile.TemporaryDirectory() as root:
            logger = LocalOptimizationLogger.create(root, RUN_ID)
            sink = RecordingSink(); sink.local_logger = logger
            callback = OrizuCallback(sink, RUN_ID, log_row_snapshots=True)
            callback.on_candidate_selected({"iteration": 1, "candidate_idx": 0})
            callback.on_proposal_start({"iteration": 1, "components": ["a", "b"], "parent_candidate": {"a": "A", "b": "B"}})
            callback.on_proposal_end({
                "iteration": 1, "new_instructions": {"a": "A2", "b": "B2"},
                "prompts": {"a": "gepa a", "b": "gepa b"}, "raw_lm_outputs": {"a": "ra"},
            })
            callback.on_candidate_accepted({"iteration": 1, "new_candidate_idx": 1, "new_score": 0.9, "parent_ids": [0]})
            rows = _jsonl(Path(root) / RUN_ID / "reflections.jsonl")

        self.assertEqual([row["component"] for row in rows], ["a", "b"])
        self.assertEqual([row["candidate_text"] for row in rows], ["A2", "B2"])
        self.assertEqual([row["prompt"] for row in rows], ["gepa a", "gepa b"])
        self.assertEqual(rows[1]["response"], "")


if __name__ == "__main__":
    unittest.main()
