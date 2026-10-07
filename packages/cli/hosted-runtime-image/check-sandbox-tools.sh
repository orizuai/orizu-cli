#!/bin/bash
# ORI-2258 / ORI-2261: prove ripgrep runs and `orizu apps preview` renders an
# app with documented component inputs to a screenshot with nothing installed
# at run time. The bake runs it
# before capture and check-snapshot-starts.mjs runs it in a sandbox started
# from the snapshot, whose network is blocked, so it must stay offline.
set -euo pipefail

rg --version
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
cd "$dir"
printf '%s\n' \
  'import React from "react"' \
  'import { CodeBlock } from "@/components/base/content/CodeBlock"' \
  'import { ContentRenderer } from "@/components/base/content/ContentRenderer"' \
  'export default function App({ inputData, onComplete, initialValues }) {' \
  '  React.useLayoutEffect(() => {' \
  '    if (!document.querySelector(".code-lines").textContent.includes("const answer = 42;") || document.querySelector(".custom-media").textContent !== "Rendered custom media") throw new Error("Documented preview component inputs were not rendered")' \
  '  }, [])' \
  '  return <main className="p-6"><h1 className="text-2xl font-bold text-orange-600">{String(inputData.text)}</h1>' \
  '    <CodeBlock className="code-lines" code={[{ number: 1, content: "const answer = 42;" }]} />' \
  '    <ContentRenderer contentType="custom" content={{ label: "Rendered custom media" }} customRenderer={({ content }) => <span className="custom-media">{content.label}</span>} />' \
  '    <button onClick={() => onComplete({ ok: true })}>Done</button></main>' \
  '}' > App.tsx
printf '%s\n' '{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}' > input.json
printf '%s\n' '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"]}' > output.json
printf '%s\n' '{"text":"preview check"}' > row.json
orizu apps preview --file App.tsx --input-schema input.json --output-schema output.json --sample-row row.json --screenshot preview.png 2> preview.err \
  || { cat preview.err >&2; exit 1; }
cat preview.err >&2
# The preview falls back to unstyled CSS when Tailwind cannot build; that fails the check.
if grep -q 'Tailwind CSS could not be built' preview.err; then echo 'check-sandbox-tools.sh: the preview could not build Tailwind CSS' >&2; exit 1; fi
if [ ! -s preview.png ]; then echo 'check-sandbox-tools.sh: orizu apps preview wrote no screenshot' >&2; exit 1; fi
echo "app preview screenshot: $(wc -c < preview.png) bytes"
