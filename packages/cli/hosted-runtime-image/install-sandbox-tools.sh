#!/bin/bash
# ORI-2258 / ORI-2261: tools every hosted session gets. Run as root by both
# bake paths (the Dockerfile and provision-snapshot.mjs), on Amazon Linux 2023.
# - ripgrep: not in the AL2023 repo, so the upstream static binary, checked
#   against the .sha256 each release publishes.
# - `orizu apps preview` packages, at the exact versions the CLI's lockfile
#   tests with, in /opt/orizu/node_modules. Not /opt/orizu/cli: the published
#   CLI lists them as dev dependencies, so its --omit=dev install skips them.
#   The CLI and Node both look in the parent folder already.
# - Playwright's headless Chromium, installed by that same @playwright/test so
#   the browser always matches it, linked to /usr/bin/chromium (a path
#   preview-runtime.ts already tries), plus the libraries and fonts it needs.
set -euo pipefail

RIPGREP_VERSION=15.2.0
case "$(uname -m)" in
  x86_64) RIPGREP_TARGET=x86_64-unknown-linux-musl; RIPGREP_SHA256=33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c ;;
  aarch64) RIPGREP_TARGET=aarch64-unknown-linux-musl; RIPGREP_SHA256=800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915 ;;
  *) echo "install-sandbox-tools.sh: unsupported machine $(uname -m); only x86_64 and aarch64 were measured" >&2; exit 1 ;;
esac

# The script's own tools (the minimal amazonlinux:2023 image has no find, tar or
# gzip), then Chromium's libraries: from ldd on the browser and Playwright's rpm.deps.
dnf -y install findutils tar gzip \
  nss nspr atk at-spi2-atk at-spi2-core cups-libs dbus-libs libX11 libXcomposite libXdamage \
  libXext libXfixes libXrandr mesa-libgbm libxcb libxkbcommon alsa-lib fontconfig liberation-fonts
dnf clean all
rm -rf /var/cache/dnf

ripgrep="ripgrep-${RIPGREP_VERSION}-${RIPGREP_TARGET}"
curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${ripgrep}.tar.gz" -o "/tmp/${ripgrep}.tar.gz"
echo "${RIPGREP_SHA256}  /tmp/${ripgrep}.tar.gz" | sha256sum -c -
tar -xzf "/tmp/${ripgrep}.tar.gz" -C /tmp
install "/tmp/${ripgrep}/rg" /usr/local/bin/rg
rm -rf "/tmp/${ripgrep}.tar.gz" "/tmp/${ripgrep}"

npm install --prefix /opt/orizu --no-save --package-lock=false \
  esbuild@0.25.12 react@19.2.6 react-dom@19.2.6 @playwright/test@1.61.1 \
  tailwindcss@4.3.2 @tailwindcss/postcss@4.3.2 postcss@8.5.16
npm cache clean --force

PLAYWRIGHT_BROWSERS_PATH=/opt/orizu/ms-playwright node /opt/orizu/node_modules/@playwright/test/cli.js install chromium-headless-shell
# x86_64 builds name the binary chrome-headless-shell; the arm64 fallback build, headless_shell.
shell="$(find /opt/orizu/ms-playwright -path '*/chromium_headless_shell-*' -type f \( -name chrome-headless-shell -o -name headless_shell \))"
if [ "$(printf '%s\n' "$shell" | grep -c .)" != 1 ]; then echo "install-sandbox-tools.sh: expected one headless Chromium, found: ${shell:-none}" >&2; exit 1; fi
ln -sf "$shell" /usr/bin/chromium
if ldd /usr/bin/chromium | grep 'not found'; then echo 'install-sandbox-tools.sh: Chromium is missing the libraries above' >&2; exit 1; fi
chmod -R a+rX /opt/orizu/node_modules /opt/orizu/ms-playwright
