# Skilled-proposer dependency lock

`skilled-proposer.lock` is the customer-install artifact for the opt-in
skilled proposer. It has 60 active, fully transitive `==` pins on Python 3.10
and 58 on Python 3.11–3.14. There are 61 records in the file: `rpds-py` is
`0.30.0` on Python 3.10 and `2026.6.3` on Python 3.11–3.14, while Python 3.10
alone needs `async-timeout==5.0.1` and `exceptiongroup==1.3.1`.

Those Python 3.10 additions were measured with a real CPython 3.10 install and
`pip check`, not inferred from the CPython 3.14 freeze. The downloaded primary
wheel metadata declares `aiohttp`'s `async-timeout` edge and `anyio`'s
`exceptiongroup` edge for `python_version < "3.11"`; `rpds-py==2026.6.3`
declares `Requires-Python: >=3.11`.

Every hash is the SHA-256 of an actual wheel selected by pip. Source archives
are deliberately absent. The recorded wheel matrix is:

- CPython 3.10, 3.11, 3.12, 3.13, and 3.14;
- macOS 15 or newer on arm64; and
- glibc-based Linux on x86_64 when it accepts the selected manylinux 2.28 and
  manylinux2014 tags.

Windows, macOS x86_64, Linux arm64, musl Linux, macOS older than the selected
wheel floor, PyPy, and any other Python/platform combination are not covered.
The managed installer must reject a target for which pip cannot select one of
the hashed wheels; it must never fall back to an sdist.

## Regeneration

Regeneration is an attended dependency update, not an install-time operation.
Start from a clean disposable wheel root and a bootstrap CPython with pip. The
bootstrap interpreter only runs pip; `--python-version`, `--implementation`,
`--abi`, and `--platform` select each target wheel set.

1. Resolve `skilled-proposer==0.1.2` afresh on each admitted Python minor,
   inspect `pip freeze`, `pip check`, and upstream wheel `METADATA`, and update
   `skilled-proposer.in` only after reconciling the complete transitive graph.
   Do not derive expected pins from the refresh script's output.
2. Download and hash the target wheels into a new temporary directory:

   ```sh
   wheel_root="$(mktemp -d)/wheels"
   node packages/cli/scripts/refresh-skilled-proposer-lock.mjs \
     --download \
     --python .scratch-deps/venv/bin/python \
     --wheel-root "$wheel_root"
   ```

3. Review the lock diff and verify all ten target slices locally. For example,
   with the current interpreter's matching wheelhouse:

   ```sh
   .scratch-deps/venv/bin/python -m pip install \
     --dry-run --ignore-installed --no-index \
     --find-links .scratch-deps/wheels/macos-arm64-py314 \
     --require-hashes --only-binary=:all: \
     --requirement packages/cli/requirements/skilled-proposer.lock
   ```

   Repeat from the matching CPython for every admitted minor and both target
   platforms. A cross-target `pip download` proves artifact selection, not that
   a foreign native wheel imports on the bootstrap machine.
4. Preserve the reviewed wheelhouses long enough to reproduce the file and
   check that it is byte-for-byte current:

   ```sh
   node packages/cli/scripts/refresh-skilled-proposer-lock.mjs \
     --check --wheel-root "$wheel_root"
   ```

The refresh script refuses missing, extra, duplicate, or version-mismatched
wheels. Publication still requires native import/constructor and `pip check`
validation on each actual target; those runtime results cannot be inferred
from cross-platform wheel downloads.

## Managed-venv lifecycle notes

The manager takes a per-publish-key POSIX advisory lock through the selected
CPython's `fcntl.flock`. The lock-holder forks a guardian that inherits the
same locked file description: loss of the leader cannot expose the still-live
Node/Bun builder, and the guardian exits when that parent finishes or dies.
The 20-minute waiter bound exceeds the longest bounded repair path: two-minute
existing-cache validation, two-minute venv creation, ten-minute install, and
two-minute staged validation, with time left for cleanup, publication, and
release. The guardian has its own 25-minute fail-safe bound.

`executedPipArgv` means the exact pip command executed by the reporting manager
process. It is an array only for the process that built the published venv and
is `null` on cache hits and lock waiters that reused another process's result.
The advisory lock file itself is persistent, contains no ownership claim, and
is safe to encounter after an interrupted process.

Staged directories for the current publish key are removed while holding that
key's lock. Manager-shaped stages for other keys are removed only after 24
hours, well beyond the maximum admitted builder/guardian lifetime. Published
venvs are retained indefinitely; automated published-venv GC is intentionally
deferred, so operators may remove the whole regenerable skilled-proposer cache
when disk reclamation is required.

An inherited non-empty `SSL_CERT_FILE` is passed through unchanged. Otherwise
the manager tries Python's default CA locations and common system paths. If no
file resolves, installation continues without setting `SSL_CERT_FILE` because
pip uses its bundled trust store; the JSON report includes the warning code
`ALI_1505_SSL_CERT_FILE_UNRESOLVED`. Provider traffic may still require the
operator to set the organization's PEM bundle explicitly.

Static lock syntax errors use `ALI_1505_LOCK_FORMAT_INVALID`; an artifact whose
bytes disagree with a syntactically valid locked digest uses
`ALI_1505_ARTIFACT_HASH_MISMATCH`. `ALI_1505_LOCK_UNHASHED_REQUIREMENT` remains
the diagnostic for a missing exact pin or missing hash.

The lifecycle fault-injection variables are test-only. None of
`ORIZU_ALI1505_TEST_INTERRUPT_AFTER`,
`ORIZU_ALI1505_TEST_KILL_PUBLISH_LOCK_LEADER`, or
`ORIZU_ALI1505_TEST_START_BARRIER` is honored unless the test process also sets
`ORIZU_ALI1505_TEST_HOOKS=1`.
The CA warning boundary test additionally uses the master-gated
`ORIZU_ALI1505_TEST_FORCE_CA_UNRESOLVED=1`; it is not a customer setting.

## Manager guard mutation proof

On 2026-08-20 each production guard below was changed in isolation with a
behavioral mutation, its named test was run, and the production guard was then
restored. These were source mutations, not syntax errors or mutations of test
fakes.

| Production mutant | Test that went red | Observed failure |
| --- | --- | --- |
| Remove `--require-hashes` from the actual pip argv | `publishes a content-addressed venv with hardened pip and launch reporting` | Exact-argv assertion showed the missing flag. |
| Bypass `acquirePublishLock` so both callers build | `the CI boundary lock fake permits exactly one concurrent builder` | One of the two manager processes exited 1 instead of both exiting 0; the real-lock companion is the local dependency E2E. |
| Replace the production interpreter preflight with an admitted hard-coded identity | `rejects unsupported CPython before cache or python -m mutation` | The selected fake reached cache/lock mutation and reported `ALI_1505_PUBLISH_LOCK_FAILED` instead of the required early `ALI_1505_UNSUPPORTED_CPYTHON`. |
| Remove published-venv `pip check` revalidation | `revalidates pip consistency and imports before reusing a published environment` | The deliberately inconsistent cached venv was reused (`publishedVenv: false`) instead of rebuilt. |
| Ignore unmatched malformed `--hash` tokens after one valid hash | `rejects missing, unhashed, and malformed-hash locks before cache mutation` | A record ending in a bare `--hash=` was accepted and the manager exited 0. |
| Make the forked guardian close its inherited lock immediately | Real `DependencyE2E.test_concurrent_first_use_publishes_one_complete_keyed_venv` with both leaders killed | Both real installers built; one failed atomic publication with `ALI_1505_VENV_PUBLISH_FAILED`/`ENOTEMPTY`. |
| Report malformed static hash syntax as an artifact mismatch | `rejects missing, unhashed, and malformed-hash locks before cache mutation` | Expected `ALI_1505_LOCK_FORMAT_INVALID`, received `ALI_1505_ARTIFACT_HASH_MISMATCH`. |
| Report pip's real digest refusal as a static lock-format defect | `distinguishes a pip artifact digest mismatch from a static lock-format defect` | Expected `ALI_1505_ARTIFACT_HASH_MISMATCH`, received `ALI_1505_LOCK_FORMAT_INVALID`. |
| Ignore the `ORIZU_ALI1505_TEST_HOOKS=1` master gate | `test-only lifecycle hooks require the explicit master switch` | The unmastered interrupt hook activated and the manager exited 1. |
| Disable aged cross-key stage collection | `first use prunes only aged abandoned stages belonging to other publish keys` | The two-day-old foreign-key stage remained present. |
