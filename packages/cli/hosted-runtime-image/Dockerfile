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
#   NODE_MAJOR             → Node major line to install (24)
ARG ORIZU_CLI_GIT_VERSION=source-unknown
ARG OPENCODE_VERSION=1.14.41
ARG CLAUDE_SDK_VERSION=0.3.201
ARG NODE_MAJOR=24

# --- OS packages + git --------------------------------------------------------
RUN dnf -y update \
  && dnf -y install git tar gzip xz which shadow-utils ca-certificates \
  && dnf clean all \
  && rm -rf /var/cache/dnf

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

# --- Pre-baked marker ---------------------------------------------------------
# The runtime DETECTS it is pre-baked from this file (belt) + the boot-context
# `prebaked` flag (braces). hosted-runtime-assets.ts `parsePrebakedMarker` parses
# `cliVersion / opencodeVersion / claudeSdkVersion / builtFor`. Because the CLI is
# baked FROM SOURCE, `cliVersion` records the git PROVENANCE string (not an npm
# version), and extra `cliSource` / `cliGitVersion` fields make that explicit (the
# parser ignores unknown fields). Written via printf so the values are captured
# verbatim from the build ARGs above.
RUN mkdir -p /opt/orizu \
  && printf '{\n  "cliVersion": "%s",\n  "cliSource": "from-source",\n  "cliGitVersion": "%s",\n  "opencodeVersion": "%s",\n  "claudeSdkVersion": "%s",\n  "builtFor": "vercel-sandbox"\n}\n' \
    "${ORIZU_CLI_GIT_VERSION}" "${ORIZU_CLI_GIT_VERSION}" "${OPENCODE_VERSION}" "${CLAUDE_SDK_VERSION}" \
    > /opt/orizu/prebaked.json \
  && cat /opt/orizu/prebaked.json

# --- Sandbox working directory ------------------------------------------------
# The provider clones/execs relative to the sandbox cwd; Vercel Sandbox uses
# /vercel/sandbox as the working root, so match it (bootstrap resolves the true
# root via `pwd`, so this only needs to be a sane, writable default).
WORKDIR /vercel/sandbox
