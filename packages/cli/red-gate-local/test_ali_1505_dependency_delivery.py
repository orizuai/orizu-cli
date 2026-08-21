"""Local-only ALI-1505 dependency-delivery red gate.

This file is intentionally outside normal test discovery: it creates only
temporary directories and invokes pip solely with --no-index and a local
fixture wheelhouse. It never contacts a package index, LLM provider, or
customer system.

Run with:
  .scratch-deps/venv/bin/python \
    packages/cli/red-gate-local/test_ali_1505_dependency_delivery.py

The production command exercised after implementation is deliberately a
small, non-interactive CLI contract:

  bun packages/cli/scripts/ensure-skilled-proposer-venv.mjs \
    --python <path> --cache-root <path> --lock <path> \
    --wheelhouse <path> --no-index --json

For deterministic interruption only, the command must honour
ORIZU_ALI1505_TEST_INTERRUPT_AFTER=staged-install when that exact variable
is explicitly supplied together with `ORIZU_ALI1505_TEST_HOOKS=1`. It must
exit non-zero with the named test diagnostic
without publishing the staged directory. This is a test hook, not a customer
configuration surface. The contention test also uses the exact internal hook
ORIZU_ALI1505_TEST_KILL_PUBLISH_LOCK_LEADER=after-acquire to prove the forked
guardian retains the real advisory lock if its leader is killed.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import time
import unittest


REPO_ROOT = Path(__file__).resolve().parents[3]
PRODUCT_LOCK = REPO_ROOT / "packages/cli/requirements/skilled-proposer.lock"
MANAGER = REPO_ROOT / "packages/cli/scripts/ensure-skilled-proposer-venv.mjs"
SCRATCH_PYTHON = REPO_ROOT / ".scratch-deps/venv/bin/python"
WHEELHOUSE = Path(os.environ.get(
    "ORIZU_ALI1505_WHEELHOUSE",
    str(REPO_ROOT / ".scratch-deps/wheels/macos-arm64-py314"),
))


def _run(command: list[str], *, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, text=True, capture_output=True, check=False, env=env)


class DependencyE2E(unittest.TestCase):
    """All tests start at the product boundary after the red product precheck."""

    def require_product_contract(self) -> None:
        self.assertTrue(
            PRODUCT_LOCK.is_file(),
            f"ALI_1505_LOCK_MISSING: expected checked-in hash lock at {PRODUCT_LOCK}",
        )
        self.assertTrue(
            MANAGER.is_file(),
            f"ALI_1505_VENV_MANAGER_MISSING: expected production manager at {MANAGER}",
        )
        self.assertTrue(
            SCRATCH_PYTHON.is_file(),
            f"ALI_1505_RED_GATE_SETUP_MISSING: expected {SCRATCH_PYTHON}",
        )
        self.assertTrue(
            WHEELHOUSE.is_dir(),
            f"ALI_1505_RED_GATE_SETUP_MISSING: expected {WHEELHOUSE}",
        )

    def require_local_pip_fixture(self) -> None:
        self.assertTrue(
            SCRATCH_PYTHON.is_file(),
            f"ALI_1505_RED_GATE_SETUP_MISSING: expected {SCRATCH_PYTHON}",
        )
        self.assertTrue(
            WHEELHOUSE.is_dir(),
            f"ALI_1505_RED_GATE_SETUP_MISSING: expected {WHEELHOUSE}",
        )

    def manager(self, cache_root: Path, lock: Path, *, python: Path = SCRATCH_PYTHON,
                environment: dict[str, str] | None = None,
                wheelhouse: Path = WHEELHOUSE, vendored_gepa_path: Path | None = None) -> subprocess.CompletedProcess[str]:
        command = [
            "bun", str(MANAGER),
            "--python", str(python),
            "--cache-root", str(cache_root),
            "--lock", str(lock),
            "--wheelhouse", str(wheelhouse),
            "--no-index",
            "--json",
        ]
        if vendored_gepa_path is not None:
            command.extend(["--vendored-gepa-path", str(vendored_gepa_path)])
        env = dict(os.environ)
        env["SSL_CERT_FILE"] = "/synthetic/ca.pem"
        if environment:
            env.update(environment)
        return _run(command, env=env)

    def assert_hardened_pip_report(self, report: dict, lock: Path) -> None:
        """The report is the real manager subprocess contract, not a planner fake."""
        pip_argv = report["executedPipArgv"]
        self.assertIn("--require-hashes", pip_argv)
        self.assertIn("--only-binary=:all:", pip_argv)
        self.assertIn("--no-index", pip_argv)
        self.assertIn(str(lock), pip_argv)

    def test_tampered_hash_is_rejected_by_real_pip(self):
        """Mutant: omit --require-hashes, accept pip failure, or rewrite the lock."""
        self.require_local_pip_fixture()
        with tempfile.TemporaryDirectory(prefix="orizu-ali1505-tampered-") as temporary:
            requirement = Path(temporary) / "tampered.lock"
            requirement.write_text(
                "skilled-proposer==0.1.2 --hash=sha256:" + "0" * 64 + "\n",
                encoding="utf8",
            )
            result = _run([
                str(SCRATCH_PYTHON), "-m", "pip", "install", "--dry-run", "--ignore-installed", "--no-index",
                "--find-links", str(WHEELHOUSE), "--no-deps", "--require-hashes",
                "--only-binary=:all:", "--requirement", str(requirement),
            ])
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("hash", (result.stdout + result.stderr).lower())

            self.require_product_contract()
            managed = self.manager(Path(temporary) / "cache", requirement)
            self.assertNotEqual(managed.returncode, 0)
            self.assertIn("ALI_1505_ARTIFACT_HASH_MISMATCH", managed.stdout + managed.stderr)

    def test_unhashed_requirement_is_rejected_by_real_pip(self):
        """Mutant: retry a failed lock install with a bare/unhashed requirement."""
        self.require_local_pip_fixture()
        with tempfile.TemporaryDirectory(prefix="orizu-ali1505-unhashed-") as temporary:
            requirement = Path(temporary) / "unhashed.lock"
            requirement.write_text("skilled-proposer==0.1.2\n", encoding="utf8")
            result = _run([
                str(SCRATCH_PYTHON), "-m", "pip", "install", "--dry-run", "--ignore-installed", "--no-index",
                "--find-links", str(WHEELHOUSE), "--no-deps", "--require-hashes",
                "--only-binary=:all:", "--requirement", str(requirement),
            ])
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("hash", (result.stdout + result.stderr).lower())

            self.require_product_contract()
            managed = self.manager(Path(temporary) / "cache", requirement)
            self.assertNotEqual(managed.returncode, 0)
            self.assertIn("ALI_1505_LOCK_UNHASHED_REQUIREMENT", managed.stdout + managed.stderr)

    def test_sdist_only_wheelhouse_is_refused_without_build(self):
        """Mutant: remove --only-binary=:all: and allow an sdist build on first use."""
        self.require_local_pip_fixture()
        with tempfile.TemporaryDirectory(prefix="orizu-ali1505-sdist-") as temporary:
            temporary_path = Path(temporary)
            sdist_house = temporary_path / "sdist-only"
            sdist_house.mkdir()
            sdist = sdist_house / "sdist-only-probe-0.0.1.tar.gz"
            with tarfile.open(sdist, "w:gz") as archive:
                source = temporary_path / "setup.py"
                source.write_text(
                    "from setuptools import setup\nsetup(name='sdist-only-probe', version='0.0.1')\n",
                    encoding="utf8",
                )
                archive.add(source, arcname="sdist-only-probe-0.0.1/setup.py")
            sdist_digest = hashlib.sha256(sdist.read_bytes()).hexdigest()
            requirement = temporary_path / "sdist.lock"
            requirement.write_text(
                f"sdist-only-probe==0.0.1 --hash=sha256:{sdist_digest}\n", encoding="utf8"
            )
            result = _run([
                str(SCRATCH_PYTHON), "-m", "pip", "install", "--dry-run", "--ignore-installed", "--no-index",
                "--find-links", str(sdist_house), "--no-deps", "--require-hashes",
                "--only-binary=:all:", "--requirement", str(requirement),
            ])
            output = result.stdout + result.stderr
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("Building wheel", output)
            self.assertNotIn("Preparing metadata", output)

            self.require_product_contract()
            managed = self.manager(
                temporary_path / "cache",
                requirement,
                wheelhouse=sdist_house,
            )
            managed_output = managed.stdout + managed.stderr
            self.assertNotEqual(managed.returncode, 0)
            self.assertIn("ALI_1505_NO_LOCKED_BINARY_WHEEL", managed_output)
            self.assertNotIn("Building wheel", managed_output)

    def test_interrupted_publish_never_exposes_a_partial_venv(self):
        """Mutant: create/reuse the final venv before pip check and smoke pass."""
        self.require_product_contract()
        with tempfile.TemporaryDirectory(prefix="orizu-ali1505-interrupt-") as temporary:
            cache_root = Path(temporary) / "cache"
            result = self.manager(
                cache_root,
                PRODUCT_LOCK,
                environment={"ORIZU_ALI1505_TEST_HOOKS": "1",
                             "ORIZU_ALI1505_TEST_INTERRUPT_AFTER": "staged-install"},
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("ALI_1505_TEST_INTERRUPT_AFTER_STAGED_INSTALL", result.stdout + result.stderr)
            repaired = self.manager(cache_root, PRODUCT_LOCK)
            self.assertEqual(repaired.returncode, 0, repaired.stdout + repaired.stderr)
            report = json.loads(repaired.stdout)
            self.assertIsNone(json.loads(result.stdout)["publishedVenv"])
            self.assertTrue(Path(report["venv"]).is_dir())
            self.assert_hardened_pip_report(report, PRODUCT_LOCK)
            venv_python = Path(report["venv"]) / "bin/python"
            self.assertEqual(_run([str(venv_python), "-m", "pip", "check"]).returncode, 0)

    def test_concurrent_first_use_publishes_one_complete_keyed_venv(self):
        """Mutant: remove the publish lock or let a losing installer corrupt winner output."""
        self.require_product_contract()
        with tempfile.TemporaryDirectory(prefix="orizu-ali1505-race-") as temporary:
            cache_root = Path(temporary) / "cache"
            barrier = cache_root / "test-start-barrier"
            barrier.parent.mkdir(parents=True)
            barrier.write_text("release only after both children are ready", encoding="utf8")
            command = [
                "bun", str(MANAGER), "--python", str(SCRATCH_PYTHON),
                "--cache-root", str(cache_root), "--lock", str(PRODUCT_LOCK),
                "--wheelhouse", str(WHEELHOUSE), "--no-index", "--json",
            ]
            environment = {**os.environ, "SSL_CERT_FILE": "/synthetic/ca.pem",
                           "ORIZU_ALI1505_TEST_HOOKS": "1",
                           "ORIZU_ALI1505_TEST_START_BARRIER": str(barrier),
                           "ORIZU_ALI1505_TEST_KILL_PUBLISH_LOCK_LEADER": "after-acquire"}
            first = subprocess.Popen(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment)
            second = subprocess.Popen(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment)
            ready_root = cache_root / "test-start-barrier-ready"
            deadline = time.monotonic() + 10
            while len(list(ready_root.glob("*"))) < 2 and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(len(list(ready_root.glob("*"))), 2, "both installers must reach the barrier")
            barrier.unlink()
            first_stdout, first_stderr = first.communicate(timeout=120)
            second_stdout, second_stderr = second.communicate(timeout=120)

            self.assertEqual(first.returncode, 0, first_stdout + first_stderr)
            self.assertEqual(second.returncode, 0, second_stdout + second_stderr)
            first_report = json.loads(first_stdout)
            second_report = json.loads(second_stdout)
            self.assertEqual(first_report["publishKey"], second_report["publishKey"])
            self.assertEqual(first_report["venv"], second_report["venv"])
            self.assertTrue(first_report["waitedForPublishLock"] or second_report["waitedForPublishLock"])
            reports = [first_report, second_report]
            self.assertEqual(sum(report["publishedVenv"] is True for report in reports), 1)
            builder = next(report for report in reports if report["publishedVenv"] is True)
            waiter = next(report for report in reports if report["publishedVenv"] is False)
            self.assertIsNone(waiter["executedPipArgv"])
            self.assertTrue(Path(first_report["venv"]).is_dir())
            self.assert_hardened_pip_report(builder, PRODUCT_LOCK)
            self.assertEqual(_run([first_report["venv"] + "/bin/python", "-m", "pip", "check"]).returncode, 0)

    def test_unsupported_python_is_refused_before_venv_or_pip(self):
        """Mutant: defer the CPython >=3.10,<3.15 preflight until after mutation."""
        self.require_product_contract()
        for version in ("3.9.99", "3.15.0"):
            with self.subTest(version=version), tempfile.TemporaryDirectory(prefix="orizu-ali1505-python-") as temporary:
                temporary_path = Path(temporary)
                pip_marker = temporary_path / "pip-was-invoked"
                fake_python = temporary_path / f"python{version}"
                fake_python.write_text(
                    "#!/bin/sh\n"
                    f"if [ \"$1\" = \"-m\" ]; then touch {pip_marker}; fi\n"
                    f"printf '{version}\\n'\n",
                    encoding="utf8",
                )
                fake_python.chmod(0o755)
                cache_root = temporary_path / "cache"
                result = self.manager(cache_root, PRODUCT_LOCK, python=fake_python)

                self.assertNotEqual(result.returncode, 0)
                self.assertIn("ALI_1505_UNSUPPORTED_CPYTHON", result.stdout + result.stderr)
                self.assertFalse(cache_root.exists(), "version preflight must precede cache/venv mutation")
                self.assertFalse(pip_marker.exists(), "unsupported Python must never reach a -m stage")

    def test_cli_shaped_import_uses_vendored_gepa_and_constructs_skilled_proposer(self):
        """Mutant: put installed gepa==0.1.1 ahead of CLI-vendored 0.1.4."""
        self.require_product_contract()
        cli_shaped_gepa = REPO_ROOT / ".scratch-deps/cli-shaped/gepa-0.1.4"
        self.assertTrue(cli_shaped_gepa.is_dir(), "ALI_1505_RED_GATE_SETUP_MISSING: vendored GEPA")
        with tempfile.TemporaryDirectory(prefix="orizu-ali1505-gepa-") as temporary:
            result = self.manager(
                Path(temporary) / "cache", PRODUCT_LOCK,
                vendored_gepa_path=cli_shaped_gepa,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = json.loads(result.stdout)
            python = Path(report["venv"]) / "bin/python"
            self.assertEqual(report["pythonPathEntries"][0], str(cli_shaped_gepa))
            probe = (
                "import gepa, skilled_proposer; "
                "assert 'cli-shaped/gepa-0.1.4' in gepa.__file__, gepa.__file__; "
                "skilled_proposer.SkilledProposer()"
            )
            result = _run([str(python), "-c", probe], env={
                **os.environ,
                "PYTHONPATH": os.pathsep.join(report["pythonPathEntries"]),
            })
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
