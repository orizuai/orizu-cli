# Orizu hosted-sandbox runtime image (ALI-1017).
#
# WHY THIS EXISTS
# Under G5 (ALI-1006) the hosted sandbox runs with DEFAULT-DENY egress: npm /
# the public internet are NOT reachable at RUNTIME. The from-scratch boot path
# used to `npm i -g` the Orizu CLI (hosted-bootstrap.ts) and `opencode-ai`
# (hosted-loop.ts) INSIDE the sandbox — both now fail closed behind the firewall.
# This image PRE-BAKES that runtime so no network fetch happens at boot: the
# build runs with full network (build-time egress is allowed), the sandbox does
# not.
#
# BASE-IMAGE CHOICE
# Vercel Sandbox executes on Amazon Linux 2023 (glibc). We base on the matching
# `amazonlinux:2023` so the baked binaries are ABI-compatible with the runtime
# the platform actually gives us — a musl base (alpine) or a mismatched glibc
# could load in the build but fault at runtime inside the sandbox. Node 24 is
# added from NodeSource (AL2023's default module tops out below 24); Bun is added
# from its official installer. Both must be on PATH because the git credential
# helper (hosted-runtime-assets.ts) and assertJsRuntimeAvailable require node>=18
# OR bun, and the loop's `nodeChildSpawner` shells out to `opencode` via node.
#
# Vercel does NOT run ENTRYPOINT/CMD — processes are started via runCommand by
# the provider (vercel-sandbox-provider.ts). We therefore set only WORKDIR +
# PATH + the baked packages; there is no long-running CMD.
#
# LEAN: zstd compression is applied at PUSH time (build-and-push.mjs), NOT here.

FROM amazonlinux:2023

# --- Build ARGs ---------------------------------------------------------------
# The npm-pinned externals keep their DEFAULTS here (source-of-truth pins). The
# CLI is NOT an npm pin — it is baked FROM SOURCE (see the CLI section below), so
# instead of a version we record its git provenance.
#   ORIZU_CLI_GIT_VERSION  → `git describe --tags --always --dirty` of the checkout
#                            the bundle was built from (passed by build-and-push.mjs;
#                            recorded in the marker as the runtime's provenance)
#   OPENCODE_VERSION       → OPENCODE_PINNED_VERSION (hosted-harness-opencode.ts)
#   CLAUDE_SDK_VERSION     → @anthropic-ai/claude-agent-sdk (package.json deps)
#   BRAINTRUST_PY_VERSION  → PyPI `braintrust` (ALI-1048, python eval harness);
#                            mirrored by DEFAULT_BRAINTRUST_PY_VERSION in
#                            provision-snapshot.mjs — keep them in sync
#   BRAINTRUST_NPM_VERSION → npm `braintrust` (TS SDK + `bt` CLI); mirrored by
#                            DEFAULT_BRAINTRUST_NPM_VERSION in provision-snapshot.mjs
#   NODE_MAJOR             → Node major line to install (24)
ARG ORIZU_CLI_GIT_VERSION=source-unknown
ARG OPENCODE_VERSION=1.14.41
ARG CLAUDE_SDK_VERSION=0.3.201
ARG BRAINTRUST_PY_VERSION=0.30.0
ARG BRAINTRUST_NPM_VERSION=3.23.1
ARG NODE_MAJOR=24

# --- OS packages + git + ssh ---------------------------------------------------
# openssh-clients: the merge-sandbox-job (ALI-1084) runs the deploy-key merge
# over git+SSH inside a one-shot sandbox from this runtime — the ssh client is a
# hard requirement, verified in the same layer (fail the bake, not the first
# prod merge).
RUN dnf -y update \
  && dnf -y install git openssh-clients tar gzip xz which shadow-utils ca-certificates \
  && dnf clean all \
  && rm -rf /var/cache/dnf \
  && git --version && ssh -V

# --- Node 24 (NodeSource) -----------------------------------------------------
RUN curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
  && dnf -y install nodejs \
  && dnf clean all \
  && rm -rf /var/cache/dnf \
  && node --version && npm --version

# --- Bun (official installer) -------------------------------------------------
ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash \
  && ln -sf /usr/local/bin/bun /usr/local/bin/bunx \
  && bun --version

# --- Orizu CLI, BAKED FROM SOURCE ---------------------------------------------
# The just-merged hosted-session commands (`orizu internal hosted-loop`) are not
# in a PUBLISHED CLI tag yet, so `npm i -g orizu@<v>` can't reliably carry them.
# build-and-push.mjs `bun build`s the CLI into a single self-contained bundle and
# stages it at ./dist/orizu.js in this context; we COPY it into a minimal package
# dir so the bundle finds its version (../package.json) and its lazily-imported
# runtime SDK (a sibling node_modules). The `orizu` bin is that bundle on PATH.
COPY dist/orizu.js /opt/orizu/cli/dist/index.js
RUN printf '{\n  "name": "orizu",\n  "version": "%s",\n  "type": "module"\n}\n' \
    "${ORIZU_CLI_GIT_VERSION}" > /opt/orizu/cli/package.json \
  && chmod +x /opt/orizu/cli/dist/index.js \
  && ln -sf /opt/orizu/cli/dist/index.js /usr/local/bin/orizu

# --- Baked npm-pinned externals (installed at BUILD time; network allowed here) -
# @anthropic-ai/claude-agent-sdk is installed AS A SIBLING of the CLI bundle so its
# lazy `import('@anthropic-ai/claude-agent-sdk')` resolves at runtime (verified: a
# module file resolves bare specifiers from its own node_modules walk). OpenCode is
# a global bin — the loop SPAWNS `opencode` (it is not imported), pinned to the
# EXACT version the driver's SSE parser is verified against.
RUN cd /opt/orizu/cli \
  && npm install --no-save --omit=dev "@anthropic-ai/claude-agent-sdk@${CLAUDE_SDK_VERSION}" \
  && npm install -g "opencode-ai@${OPENCODE_VERSION}" \
  && npm cache clean --force \
  # Fail the build loudly if the bake is broken — a broken bake must never ship as
  # a "Ready" image the runtime then can't use. Assert: the CLI runs, OpenCode is on
  # PATH, and the hosted-loop subcommand is actually wired into the baked bundle.
  && command -v orizu \
  && command -v opencode \
  && orizu --version \
  && orizu internal hosted-loop 2>&1 | grep -q 'hosted-loop --context' \
  # Assert the CLI's lazy `import('@anthropic-ai/claude-agent-sdk')` resolves from
  # the bundle's sibling node_modules (run the probe AS A FILE next to the bundle so
  # resolution matches the runtime's — a bare `-e` would resolve from cwd instead).
  && printf "const m=await import('@anthropic-ai/claude-agent-sdk');if(typeof m.query!=='function')process.exit(1);\n" \
      > /opt/orizu/cli/dist/_sdk_probe.mjs \
  && node /opt/orizu/cli/dist/_sdk_probe.mjs \
  && rm -f /opt/orizu/cli/dist/_sdk_probe.mjs

# --- Braintrust eval tooling (ALI-1048) ---------------------------------------
# Highlight's eval workflow needs Braintrust in the snapshot (runtime egress is
# default-deny, so nothing can be installed in-session). The PYTHON package is
# the primary surface (adapter eval harness, `evaluate_files`, `braintrust push`);
# braintrust on PyPI requires python>=3.10 and AL2023's system python is 3.9, so
# python3.11 (+pip) comes from the distro repos. The [cli] extra is REQUIRED — a
# bare `braintrust==X` imports fine but the CLI fails (boto3/uv/etc. live behind
# the extra). The npm package is baked for its CLI: both packages ship a
# `braintrust` bin and the PYTHON one must own the PATH name, so npm installs
# FIRST and its `braintrust` bin is REMOVED (keeping the second bin `bt`) before
# pip installs the python entry point — deterministic ownership, not a PATH-order
# accident. The removal resolves via `command -v braintrust` — the SAME
# resolution the install just produced (at that instant the only `braintrust` on
# PATH is npm's; pip has not run yet); resolving npm's prefix separately could
# differ (env/npmrc) and silently no-op. If the removal ever misses anyway, the
# ANCHORED shebang verify below fails the bake loudly. PEP 668: the system-wide
# pip install relies on AL2023's pip (22.3.1) predating EXTERNALLY-MANAGED
# enforcement; if the base image ever bumps to an enforcing pip this layer fails
# loudly at bake time (then add --break-system-packages or move to a venv). The
# global npm install is CLI prebaking only: workspace code that wants the TS SDK
# adds `braintrust` as a dependency (global installs are not on the
# module-resolution path).
# DEFAULT-python3 visibility: the GEPA runner manifest launches plain `python3`
# (packages/orizu-gepa-python/manifest.json) and the CLI spawns
# `process.env.PYTHON || 'python3'` — but /usr/bin/python3 stays 3.9 and cannot
# import braintrust. /usr/local/bin/python3 -> /usr/bin/python3.11 wins by PATH
# precedence for user-launched processes (hosted-loop spawns inherit the ambient
# PATH; nothing constructs its own) while dnf's absolute-shebang scripts keep
# using the untouched /usr/bin/python3.
RUN npm install -g "braintrust@${BRAINTRUST_NPM_VERSION}" \
  && npm cache clean --force \
  && rm -f "$(command -v braintrust)" \
  && dnf -y install python3.11 python3.11-pip \
  && dnf clean all \
  && rm -rf /var/cache/dnf \
  && python3.11 -m pip install --no-cache-dir "braintrust[cli]==${BRAINTRUST_PY_VERSION}" \
  && ln -sf /usr/bin/python3.11 /usr/local/bin/python3 \
  && ln -sf /usr/bin/pip3.11 /usr/local/bin/pip3 \
  # Fail the bake, not Highlight's first eval run: both CLIs resolve AND execute,
  # the PATH `braintrust` is the python one (ANCHORED shebang check), the DEFAULT
  # `python3` resolves to 3.11 and imports braintrust (runner processes launch
  # plain python3), and the python package imports at the pinned version.
  && command -v braintrust \
  && command -v bt \
  && head -1 "$(command -v braintrust)" | grep -Eq '^#!.*/python3\.11$' \
  && braintrust --help >/dev/null \
  && bt --help >/dev/null \
  && python3 --version | grep -F "Python 3.11" \
  && python3 -c "import braintrust" \
  && python3.11 -c "import braintrust; from importlib.metadata import version; assert version('braintrust') == '${BRAINTRUST_PY_VERSION}'"

# --- Pre-baked marker ---------------------------------------------------------
# The runtime DETECTS it is pre-baked from this file (belt) + the boot-context
# `prebaked` flag (braces). hosted-runtime-assets.ts `parsePrebakedMarker` parses
# `cliVersion / opencodeVersion / claudeSdkVersion / builtFor` (+ the OPTIONAL
# `braintrustPyVersion` / `braintrustNpmVersion` pins, ALI-1048). Because the CLI is
# baked FROM SOURCE, `cliVersion` records the git PROVENANCE string (not an npm
# version), and extra `cliSource` / `cliGitVersion` fields make that explicit (the
# parser ignores unknown fields). Written via printf so the values are captured
# verbatim from the build ARGs above.
RUN mkdir -p /opt/orizu \
  && printf '{\n  "cliVersion": "%s",\n  "cliSource": "from-source",\n  "cliGitVersion": "%s",\n  "opencodeVersion": "%s",\n  "claudeSdkVersion": "%s",\n  "braintrustPyVersion": "%s",\n  "braintrustNpmVersion": "%s",\n  "builtFor": "vercel-sandbox"\n}\n' \
    "${ORIZU_CLI_GIT_VERSION}" "${ORIZU_CLI_GIT_VERSION}" "${OPENCODE_VERSION}" "${CLAUDE_SDK_VERSION}" "${BRAINTRUST_PY_VERSION}" "${BRAINTRUST_NPM_VERSION}" \
    > /opt/orizu/prebaked.json \
  && cat /opt/orizu/prebaked.json

# --- Sandbox working directory ------------------------------------------------
# The provider clones/execs relative to the sandbox cwd; Vercel Sandbox uses
# /vercel/sandbox as the working root, so match it (bootstrap resolves the true
# root via `pwd`, so this only needs to be a sane, writable default).
WORKDIR /vercel/sandbox
