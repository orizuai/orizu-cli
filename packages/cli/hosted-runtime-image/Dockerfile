FROM amazonlinux:2023

ARG ORIZU_CLI_GIT_VERSION=source-unknown
ARG OPENCODE_VERSION=1.14.41
ARG CLAUDE_SDK_VERSION=0.3.201
ARG BRAINTRUST_PY_VERSION=0.30.0
ARG BRAINTRUST_NPM_VERSION=3.23.1
ARG NODE_MAJOR=24

RUN dnf -y install git openssh-clients tar gzip xz unzip which shadow-utils ca-certificates \
  && dnf clean all \
  && rm -rf /var/cache/dnf \
  && git --version && ssh -V

RUN curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
  && dnf -y install nodejs \
  && dnf clean all \
  && rm -rf /var/cache/dnf \
  && node --version && npm --version

ENV BUN_INSTALL=/usr/local
ARG BUN_VERSION=1.3.13
ARG BUN_LINUX_X64_BASELINE_SHA256=9d8a24292a7068090205daac0a5a223f5f69736f5287e37bf88d3b4031edc750
RUN curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64-baseline.zip" -o /tmp/bun.zip \
  && echo "${BUN_LINUX_X64_BASELINE_SHA256}  /tmp/bun.zip" | sha256sum -c - \
  && unzip -q /tmp/bun.zip -d /tmp && install /tmp/bun-linux-x64-baseline/bun /usr/local/bin/bun && rm -rf /tmp/bun.zip /tmp/bun-linux-x64-baseline \
  && ln -sf /usr/local/bin/bun /usr/local/bin/bunx \
  && test "$(bun --version)" = "${BUN_VERSION}"

RUN mkdir -p /opt/orizu/cli \
  && printf '{\n  "name": "orizu",\n  "version": "%s",\n  "type": "module"\n}\n' \
    "${ORIZU_CLI_GIT_VERSION}" > /opt/orizu/cli/package.json \
  && cat /opt/orizu/cli/package.json

RUN cd /opt/orizu/cli \
  && npm install --no-save --omit=dev "@anthropic-ai/claude-agent-sdk@${CLAUDE_SDK_VERSION}" \
  && npm install -g "opencode-ai@${OPENCODE_VERSION}" \
  && npm cache clean --force

RUN npm install -g "braintrust@${BRAINTRUST_NPM_VERSION}" \
  && npm cache clean --force \
  && rm -f "$(command -v braintrust)" \
  && dnf -y install python3.11 python3.11-pip \
  && dnf clean all \
  && rm -rf /var/cache/dnf \
  && python3.11 -m pip install --no-cache-dir "braintrust[cli]==${BRAINTRUST_PY_VERSION}" \
  && ln -sf /usr/bin/python3.11 /usr/local/bin/python3 \
  && ln -sf /usr/bin/pip3.11 /usr/local/bin/pip3 \
  && command -v braintrust \
  && command -v bt \
  && head -1 "$(command -v braintrust)" | grep -Eq '^#!.*/python3\.11$' \
  && braintrust --help >/dev/null \
  && bt --help >/dev/null \
  && python3 --version | grep -F "Python 3.11" \
  && python3 -c "import braintrust" \
  && python3.11 -c "import braintrust; from importlib.metadata import version; assert version('braintrust') == '${BRAINTRUST_PY_VERSION}'"

COPY packages/cli/hosted-runtime-image/dist/orizu.js /opt/orizu/cli/dist/index.js
COPY packages/cli/hosted-runtime-image/dist/skilled-proposer-assets.json /tmp/skilled-proposer-assets.json
RUN node -e 'const f=require("fs"),p=require("path"),o=JSON.parse(f.readFileSync(process.argv[1],"utf8"));for(const [n,v] of Object.entries(o)){const d=p.join(process.argv[2],n);f.mkdirSync(p.dirname(d),{recursive:true});f.writeFileSync(d,Buffer.from(v,"base64"))}' /tmp/skilled-proposer-assets.json /opt/orizu/cli \
  && rm -f /tmp/skilled-proposer-assets.json
RUN chmod +x /opt/orizu/cli/dist/index.js \
  && ln -sf /opt/orizu/cli/dist/index.js /usr/local/bin/orizu \
  && command -v orizu && command -v opencode && orizu --version \
  && orizu internal hosted-loop 2>&1 | grep -q 'hosted-loop --context' \
  && printf "const m=await import('@anthropic-ai/claude-agent-sdk');if(typeof m.query!=='function')process.exit(1);\n" > /opt/orizu/cli/dist/_sdk_probe.mjs \
  && node /opt/orizu/cli/dist/_sdk_probe.mjs && rm -f /opt/orizu/cli/dist/_sdk_probe.mjs

RUN mkdir -p /opt/orizu \
  && printf '{\n  "cliVersion": "%s",\n  "cliSource": "from-source",\n  "cliGitVersion": "%s",\n  "opencodeVersion": "%s",\n  "claudeSdkVersion": "%s",\n  "braintrustPyVersion": "%s",\n  "braintrustNpmVersion": "%s",\n  "builtFor": "vercel-sandbox"\n}\n' \
    "${ORIZU_CLI_GIT_VERSION}" "${ORIZU_CLI_GIT_VERSION}" "${OPENCODE_VERSION}" "${CLAUDE_SDK_VERSION}" "${BRAINTRUST_PY_VERSION}" "${BRAINTRUST_NPM_VERSION}" \
    > /opt/orizu/prebaked.json \
  && cat /opt/orizu/prebaked.json

RUN node /opt/orizu/cli/scripts/vendor-gepa-python.mjs --archive /opt/orizu/cli/gepa-python-source.zip --destination /opt/orizu/cli/vendor/gepa-python \
  && rm -f /opt/orizu/cli/gepa-python-source.zip \
  && orizu internal bake-skilled-proposer-venv --json

RUN mkdir -p /vercel/sandbox/repo \
  && cd /vercel/sandbox/repo \
  && orizu internal verify-skilled-proposer-bake --json > /opt/orizu/skilled-proposer-build-verification.json

COPY packages/cli/red-gate-local/verify_ali_1588_hosted_artifact.ts /opt/orizu/cli/red-gate-local/verify_ali_1588_hosted_artifact.ts

WORKDIR /vercel/sandbox
