/**
 * The customer-side half of `orizu scorers verify-parity` (ALI-1554).
 *
 * Embedded as a string constant and written to a temp file at run time on
 * purpose: no packaging (`files`/`vendor`) change, so there is nothing for the
 * published tarball to lose. It runs in the CUSTOMER's interpreter and the
 * customer's unscrubbed environment — it is their metric in their process.
 *
 * Contract: reads `{rows: [{row_id, row, model_output}]}` from
 * ORIZU_PARITY_INPUT_PATH, calls `<module>:<function>(row, model_output)` per
 * row, and writes `{scores: [{row_id, score} | {row_id, error}]}` to
 * ORIZU_PARITY_OUTPUT_PATH. Exit 2 (with the reason on stderr) means the check
 * could not run at all; a per-row exception is that row's error, not an abort.
 */
export const PARITY_BRIDGE_SOURCE = `import json, math, os, sys, traceback


def fail(message):
    sys.stderr.write(message + "\\n")
    sys.exit(2)


def last_line(text):
    lines = [line for line in text.strip().splitlines() if line.strip()]
    return lines[-1] if lines else "unknown error"


def extract(value):
    # Mirrors orizu_gepa.optimizer._score_from_scorer, minus the clamp: the
    # CLI clamps both sides so the compared number is what GEPA optimizes.
    # bool is deliberately NOT rejected: measured, _score_from_scorer(extra=
    # {'score': True}) -> (1.0, None) and False -> (0.0, None), because bool is an
    # int subclass and Python's numeric branch accepts it. An exact-match DSPy
    # metric returning True must compare, not error.
    if isinstance(value, (int, float)):
        raw = value
    elif isinstance(value, dict):
        raw = value.get("score")
        if raw is None and isinstance(value.get("model_response"), dict):
            raw = value["model_response"].get("score")
    elif hasattr(value, "score"):
        # official GEPA's EvaluationResult NamedTuple and friends;
        # objective_scores is deliberately ignored.
        raw = value.score
    else:
        raise TypeError("scorer result must be a number, a dict with a numeric 'score', or an object with a numeric .score attribute")
    if isinstance(raw, str):
        raw = float(raw)
    if not isinstance(raw, (int, float)):
        raise TypeError("scorer result must include a numeric score")
    raw = float(raw)
    if not math.isfinite(raw):
        raise ValueError("scorer result score must be finite")
    return raw


target = os.environ.get("ORIZU_PARITY_ORIGINAL", "")
module_name, separator, function_name = target.partition(":")
if not separator or not module_name or not function_name:
    fail("--original must be <module>:<function> (got %r)" % target)

# The customer's metric lives beside the command's cwd, not beside this
# generated bridge file, so cwd must win over the script directory.
sys.path.insert(0, os.getcwd())
try:
    import importlib

    module = importlib.import_module(module_name)
except Exception:
    fail("Failed to import original metric module '%s': %s" % (module_name, last_line(traceback.format_exc())))

if not hasattr(module, function_name):
    fail("Original metric module '%s' has no attribute '%s'" % (module_name, function_name))
metric = getattr(module, function_name)
if not callable(metric):
    fail("Original metric '%s:%s' is not callable" % (module_name, function_name))

with open(os.environ["ORIZU_PARITY_INPUT_PATH"], encoding="utf-8") as handle:
    payload = json.load(handle)

scores = []
for item in payload["rows"]:
    try:
        scores.append({"row_id": item["row_id"], "score": extract(metric(item["row"], item["model_output"]))})
    except Exception:
        scores.append({"row_id": item["row_id"], "error": last_line(traceback.format_exc())})

with open(os.environ["ORIZU_PARITY_OUTPUT_PATH"], "w", encoding="utf-8") as handle:
    json.dump({"scores": scores}, handle)
`
