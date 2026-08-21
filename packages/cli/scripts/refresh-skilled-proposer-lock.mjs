#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(cliRoot, "../..");
const inputPath = join(cliRoot, "requirements", "skilled-proposer.in");
const lockPath = join(cliRoot, "requirements", "skilled-proposer.lock");

const TARGETS = [
  { name: "macos-arm64", platforms: ["macosx_15_0_arm64"] },
  {
    name: "linux-x86_64",
    platforms: ["manylinux_2_28_x86_64", "manylinux2014_x86_64"],
  },
];
const PYTHON_MINORS = ["3.10", "3.11", "3.12", "3.13", "3.14"];

function parseArguments(argv) {
  const options = {
    check: false,
    download: false,
    python: join(repositoryRoot, ".scratch-deps", "venv", "bin", "python"),
    wheelRoot: join(repositoryRoot, ".scratch-deps", "wheels"),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--download") options.download = true;
    else if (argument === "--python") options.python = resolve(argv[++index]);
    else if (argument === "--wheel-root") options.wheelRoot = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.check && options.download) {
    throw new Error("--check and --download are mutually exclusive");
  }
  return options;
}

function canonicalizeName(name) {
  return name.toLowerCase().replace(/[._-]+/g, "-");
}

function parsePins() {
  return readFileSync(inputPath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const match = /^([A-Za-z0-9._-]+)==([^ ;]+)(?:\s*;\s*(.+))?$/u.exec(line);
      if (!match) throw new Error(`Invalid fully pinned requirement: ${line}`);
      return {
        name: canonicalizeName(match[1]),
        version: match[2],
        marker: match[3] ?? null,
        source: line,
      };
    });
}

function pinApplies(pin, pythonMinor) {
  if (!pin.marker) return true;
  if (pin.marker === 'python_version == "3.10"') return pythonMinor === "3.10";
  if (pin.marker === 'python_version >= "3.11" and python_version < "3.15"') {
    return pythonMinor !== "3.10";
  }
  throw new Error(`Unsupported environment marker in ${pin.source}`);
}

function activePins(pins, pythonMinor) {
  const active = pins.filter((pin) => pinApplies(pin, pythonMinor));
  const names = new Set(active.map((pin) => pin.name));
  const expectedCount = pythonMinor === "3.10" ? 60 : 58;
  if (active.length !== expectedCount || names.size !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} unique active pins for Python ${pythonMinor}; found ${active.length}`,
    );
  }
  return active;
}

function wheelIdentity(filename) {
  const match = /^(.+?)-([^-]+)-[^-]+-[^-]+-[^-]+\.whl$/u.exec(filename);
  if (!match) throw new Error(`Not a wheel filename: ${filename}`);
  return { name: canonicalizeName(match[1]), version: match[2] };
}

function downloadWheelhouse(options, target, pythonMinor, pins) {
  const wheelhouse = join(
    options.wheelRoot,
    `${target.name}-py${pythonMinor.replace(".", "")}`,
  );
  const temporary = mkdtempSync(join(tmpdir(), "orizu-ali-1505-pins-"));
  const requirements = join(temporary, "requirements.txt");
  writeFileSync(
    requirements,
    `${activePins(pins, pythonMinor)
      .map(({ name, version }) => `${name}==${version}`)
      .join("\n")}\n`,
  );
  const pipArguments = [
    "-m",
    "pip",
    "download",
    "--disable-pip-version-check",
    "--no-deps",
    "--only-binary=:all:",
    "--implementation",
    "cp",
    "--python-version",
    pythonMinor.replace(".", ""),
    "--abi",
    `cp${pythonMinor.replace(".", "")}`,
  ];
  for (const platform of target.platforms) {
    pipArguments.push("--platform", platform);
  }
  pipArguments.push("--dest", wheelhouse, "--requirement", requirements);
  try {
    execFileSync(options.python, pipArguments, { stdio: "inherit", timeout: 10 * 60 * 1000 });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function digestWheel(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function collectWheelHashes(options, pins) {
  const hashes = new Map(pins.map((pin) => [pin.source, new Set()]));

  for (const target of TARGETS) {
    for (const pythonMinor of PYTHON_MINORS) {
      const active = activePins(pins, pythonMinor);
      const activeByIdentity = new Map(
        active.map((pin) => [`${pin.name}==${pin.version}`, pin]),
      );
      const wheelhouse = join(
        options.wheelRoot,
        `${target.name}-py${pythonMinor.replace(".", "")}`,
      );
      const files = readdirSync(wheelhouse).filter((file) => file.endsWith(".whl"));
      const found = new Set();
      for (const file of files) {
        const identity = wheelIdentity(file);
        const key = `${identity.name}==${identity.version}`;
        const pin = activeByIdentity.get(key);
        if (!pin) throw new Error(`Unexpected wheel in ${wheelhouse}: ${file}`);
        if (found.has(pin.name)) {
          throw new Error(`Multiple wheels for ${pin.name} in ${wheelhouse}`);
        }
        found.add(pin.name);
        hashes.get(pin.source).add(digestWheel(join(wheelhouse, file)));
      }
      const missing = active.filter((pin) => !found.has(pin.name));
      if (missing.length > 0) {
        throw new Error(
          `Missing wheels in ${wheelhouse}: ${missing.map((pin) => pin.source).join(", ")}`,
        );
      }
    }
  }
  return hashes;
}

function renderLock(pins, hashes) {
  const header = [
    "# Generated by packages/cli/scripts/refresh-skilled-proposer-lock.mjs.",
    "# Do not edit by hand; see packages/cli/requirements/README.md.",
    "#",
    "# Wheel-only coverage: CPython 3.10-3.14 on macOS 15+ arm64 and",
    "# glibc-based Linux x86_64 compatible with the locked manylinux wheels.",
    "# Other OS/architecture/libc combinations are intentionally not covered.",
    "",
  ];
  const continuation = ` ${String.fromCharCode(92, 10)}`;
  const requirements = [...pins]
    .sort((left, right) => left.source.localeCompare(right.source))
    .map((pin) => {
      const pinHashes = [...hashes.get(pin.source)].sort();
      if (pinHashes.length === 0) throw new Error(`No wheel hash for ${pin.source}`);
      const hashLines = pinHashes
        .map((hash) => `    --hash=sha256:${hash}`)
        .join(continuation);
      return pin.source + continuation + hashLines;
    });
  return `${header.join("\n")}${requirements.join("\n")}\n`;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const pins = parsePins();
  if (options.download) {
    for (const target of TARGETS) {
      for (const pythonMinor of PYTHON_MINORS) {
        downloadWheelhouse(options, target, pythonMinor, pins);
      }
    }
  }
  const lock = renderLock(pins, collectWheelHashes(options, pins));
  if (options.check) {
    if (readFileSync(lockPath, "utf8") !== lock) {
      throw new Error(`${lockPath} is stale; regenerate it from verified wheelhouses`);
    }
    process.stdout.write(`Verified ${lockPath}\n`);
    return;
  }
  const temporaryLock = join(
    dirname(lockPath),
    `.skilled-proposer.lock-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    const temporaryDescriptor = openSync(temporaryLock, "wx");
    try {
      writeFileSync(temporaryDescriptor, lock);
      fsyncSync(temporaryDescriptor);
    } finally {
      closeSync(temporaryDescriptor);
    }
    renameSync(temporaryLock, lockPath);
    const requirementsDescriptor = openSync(dirname(lockPath), "r");
    try {
      fsyncSync(requirementsDescriptor);
    } finally {
      closeSync(requirementsDescriptor);
    }
  } finally {
    rmSync(temporaryLock, { force: true });
  }
  process.stdout.write(`Wrote ${lockPath}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
