#!/usr/bin/env node
/*
 * Offline smoke test for an Orizu labeler app.
 *
 * Usage:
 *   node test-app.mjs <App.tsx> <input.json> <output.json> [sample-payload.json]
 *
 * Checks:
 *   1. App.tsx has a single named default export (function or class).
 *   2. Default export's first parameter destructures inputData, onComplete,
 *      initialValues (and not the deprecated data, onSubmit).
 *   3. Imports resolve against the platform-provided component registry.
 *   4. input.json and output.json use only the supported JSON Schema subset:
 *      type, required, properties, items, enum.
 *   5. (Optional) sample-payload.json validates against output.json.
 *
 * Exits 0 on pass, 1 on any failure. Pure ES module — runs on node 18+
 * with no dependencies. Also runs under bun unchanged.
 */

import { readFileSync, existsSync } from "node:fs";
import process from "node:process";

const ALLOWED_SCHEMA_KEYS = new Set([
  "type",
  "required",
  "properties",
  "items",
  "enum",
  // Permitted purely as documentation; ignored by the platform.
  "title",
  "description",
]);

const ALLOWED_TYPES = new Set([
  "object",
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "null",
]);

const REQUIRED_PROPS = ["inputData", "onComplete"];
const OPTIONAL_PROPS = ["initialValues"];
const DEPRECATED_PROPS = ["data", "onSubmit"];

// Generated from lib/available-components.ts by scripts/sync-agent-doc.mjs.
// BEGIN ORIZU_AUTO_TEST_APP_IMPORTS
const AVAILABLE_IMPORTS = Object.freeze({
  "@/components/ui/button": ["Button"],
  "@/components/ui/card": ["Card"],
  "@/components/ui/carousel": ["Carousel"],
  "@/components/ui/checkbox": ["Checkbox"],
  "@/components/ui/form": ["Form"],
  "@/components/ui/input": ["Input"],
  "@/components/ui/label": ["Label"],
  "@/components/ui/progress": ["Progress"],
  "@/components/ui/radio-group": ["RadioGroup","RadioGroupItem"],
  "@/components/ui/scroll-area": ["ScrollArea"],
  "@/components/ui/select": ["Select","SelectContent","SelectItem","SelectTrigger","SelectValue"],
  "@/components/ui/separator": ["Separator"],
  "@/components/ui/switch": ["Switch"],
  "@/components/ui/table": ["Table","TableBody","TableCell","TableHead","TableHeader","TableRow","TableCaption","TableFooter"],
  "@/components/ui/tabs": ["Tabs","TabsContent","TabsList","TabsTrigger"],
  "@/components/ui/textarea": ["Textarea"],
  "@/components/ui/toggle": ["Toggle"],
  "@/components/ui/toggle-group": ["ToggleGroup","ToggleGroupItem"],
  "@/components/ui/tooltip": ["Tooltip","TooltipContent","TooltipProvider","TooltipTrigger"],
  "@/components/base/content/TextContent": ["TextContent","default"],
  "@/components/base/content/CodeBlock": ["CodeBlock","default"],
  "@/components/base/content/ConversationView": ["AssistantMessageBlock","ContextMessageBlock","ConversationMessageBlock","ConversationView","ReasoningMessageBlock","SystemMessageBlock","ToolCallBlock","ToolResultBlock","UserMessageBlock","default"],
  "@/components/base/content/ContentRenderer": ["ContentRenderer","default"],
  "@/components/base/content/Prose": ["Prose","default"],
  "@/components/base/behaviors/Annotatable": ["Annotatable","default"],
  "@/components/base/behaviors/Reactable": ["Reactable","default"],
  "@/components/base/input/CommentBox": ["CommentBox"],
  "@/components/base/input/CriterionRating": ["CriterionRating"],
  "@/components/base/input/LikertScale": ["LikertScale"],
  "@/components/base/input/NumericRating": ["NumericRating"],
  "@/components/base/input/RatingSelector": ["RatingSelector"],
  "@/components/base/input/StarRating": ["StarRating"],
  "@/components/base/input/TagPicker": ["TagPicker"],
  "@/components/base/input/ThumbsRating": ["ThumbsRating"],
  "@/components/base/ui/ComparisonPanel": ["ComparisonPanel"],
  "@/components/base/ui/DraggableItem": ["DraggableItem"],
  "@/components/templates/classification/TagSelector": ["TagSelector"],
  "@/components/templates/comparison/SideBySideComparison": ["SideBySideComparison"],
  "@/components/templates/correction/CorrectionTask": ["CorrectionTask"],
  "@/components/templates/code/CodeComparison": ["CodeComparison"],
  "@/components/templates/qa/ContextualQA": ["ContextualQA"],
  "@/components/templates/ranking/RankingList": ["RankingList"],
  "@/components/templates/rating/SingleItemRater": ["SingleItemRater"],
});
// END ORIZU_AUTO_TEST_APP_IMPORTS

const LEGACY_IMPORT_SUGGESTIONS = {
  "@/components/prose": "@/components/base/content/Prose",
  "@/components/ui/text-content": "@/components/base/content/TextContent",
  "@/components/ui/comment-box": "@/components/base/input/CommentBox",
  "@/components/ui/tag-picker": "@/components/base/input/TagPicker",
  "@/components/criterion-rating": "@/components/base/input/CriterionRating",
  "@/components/annotation/annotatable":
    "@/components/base/behaviors/Annotatable",
};

const issues = [];

function err(message) {
  issues.push({ level: "error", message });
}
function warn(message) {
  issues.push({ level: "warn", message });
}

function checkAppFile(path) {
  if (!existsSync(path)) {
    err(`App file not found: ${path}`);
    return;
  }
  const src = readFileSync(path, "utf8");

  // Strip line comments and block comments to avoid false matches.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  // 1. Find a named default export.
  const fnMatch = stripped.match(
    /export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/
  );
  const classMatch = stripped.match(
    /export\s+default\s+class\s+([A-Za-z_$][\w$]*)/
  );

  if (!fnMatch && !classMatch) {
    if (
      /export\s+default\s+(?:\(|function\s*\(|class\s*\{|memo|forwardRef)/.test(
        stripped
      )
    ) {
      err(
        "Default export is anonymous or wrapped (e.g. memo/forwardRef). Use a named function or class declaration."
      );
    } else {
      err(
        "No default export found. App.tsx must export a named function or class as default."
      );
    }
    return;
  }

  const exportName = (fnMatch && fnMatch[1]) || (classMatch && classMatch[1]);
  if (exportName === "GeneratedComponent") {
    warn(
      `Default export is named "GeneratedComponent" — consider a more descriptive name (e.g. SupportLabeler).`
    );
  }

  // 2. For function exports, check the parameter destructure.
  if (fnMatch) {
    const paramSrc = fnMatch[2] || "";
    if (!paramSrc.trim()) {
      err(
        `Default export "${exportName}" takes no parameters. It must accept { inputData, onComplete, initialValues }.`
      );
      return;
    }

    const destructure = paramSrc.match(/\{([^}]*)\}/);
    if (!destructure) {
      err(
        `Default export "${exportName}" does not destructure props. Use { inputData, onComplete, initialValues }.`
      );
      return;
    }

    const names = destructure[1]
      .split(",")
      .map((s) => s.replace(/[:=].*/, "").trim())
      .filter(Boolean);

    for (const required of REQUIRED_PROPS) {
      if (!names.includes(required)) {
        err(`Missing required prop "${required}" in default export signature.`);
      }
    }

    for (const optional of OPTIONAL_PROPS) {
      if (!names.includes(optional)) {
        warn(
          `Optional prop "${optional}" is not destructured — pre-fill on resume will be unavailable.`
        );
      }
    }

    for (const deprecated of DEPRECATED_PROPS) {
      if (names.includes(deprecated)) {
        err(
          `Deprecated prop "${deprecated}" used. Rename: data→inputData, onSubmit→onComplete.`
        );
      }
    }

    const known = new Set([
      ...REQUIRED_PROPS,
      ...OPTIONAL_PROPS,
      ...DEPRECATED_PROPS,
    ]);
    for (const name of names) {
      if (!known.has(name)) {
        warn(
          `Unknown prop "${name}" in default export signature — will be undefined at runtime.`
        );
      }
    }
  }

  // 3. Sanity check: onComplete is referenced somewhere in the body.
  if (!/onComplete\s*\(/.test(stripped)) {
    warn(
      "onComplete is destructured but never called. The annotator won't be able to submit."
    );
  }

  // 4. Validate imports against the same platform-provided registry used by
  // server-side compile validation.
  checkImports(stripped);
}

function extractImports(src) {
  const imports = [];
  const importRegex =
    /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  let match;

  while ((match = importRegex.exec(src)) !== null) {
    const specifier = match[1].trim();
    const source = match[2];
    const line = src.slice(0, match.index).split("\n").length;
    const namedMatch = specifier.match(/\{([\s\S]*?)\}/);
    const namedImports = namedMatch
      ? namedMatch[1]
          .split(",")
          .map((part) =>
            part
              .trim()
              .replace(/^type\s+/, "")
              .replace(/\s+as\s+[A-Za-z_$][\w$]*/, "")
          )
          .filter(Boolean)
      : [];
    const defaultImport = specifier
      .replace(/\{[\s\S]*?\}/, "")
      .split(",")[0]
      .trim()
      .replace(/^type\s+/, "");

    imports.push({
      defaultImport: defaultImport || null,
      namedImports,
      source,
      line,
    });
  }

  return imports;
}

function suggestImportPath(source) {
  if (LEGACY_IMPORT_SUGGESTIONS[source]) {
    return LEGACY_IMPORT_SUGGESTIONS[source];
  }

  const tail = source.split("/").pop() || "";
  const normalizedTail = tail.toLowerCase().replace(/[^a-z0-9]/g, "");
  return Object.keys(AVAILABLE_IMPORTS).find((candidate) => {
    const candidateTail = candidate.split("/").pop() || "";
    return (
      candidateTail.toLowerCase().replace(/[^a-z0-9]/g, "") === normalizedTail
    );
  });
}

function checkImports(src) {
  for (const imp of extractImports(src)) {
    if (imp.source === "react") {
      continue;
    }

    if (imp.source.startsWith(".")) {
      warn(
        `Relative import from "${imp.source}" (line ${imp.line}) — make sure the referenced file is uploaded or inline.`
      );
      continue;
    }

    const availableNames = AVAILABLE_IMPORTS[imp.source];
    if (!availableNames) {
      const suggestion = suggestImportPath(imp.source);
      err(
        suggestion
          ? `Module "${imp.source}" not found (line ${imp.line}). Use "${suggestion}".`
          : `Module "${imp.source}" not found (line ${imp.line}). Only platform-provided registry imports are supported.`
      );
      continue;
    }

    if (imp.defaultImport && !availableNames.includes("default")) {
      if (availableNames.includes(imp.defaultImport)) {
        err(
          `Default import "${imp.defaultImport}" not available from "${imp.source}" (line ${imp.line}). Use: import { ${imp.defaultImport} } from "${imp.source}".`
        );
      } else {
        err(
          `Default import "${imp.defaultImport}" not available from "${imp.source}" (line ${imp.line}). Available named exports: ${availableNames.join(", ")}.`
        );
      }
    }

    for (const name of imp.namedImports) {
      if (!availableNames.includes(name)) {
        err(
          `Named import "${name}" not available from "${imp.source}" (line ${imp.line}). Available exports: ${availableNames.join(", ")}.`
        );
      }
    }
  }
}

function walkSchema(node, path) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkSchema(item, `${path}[${i}]`));
    return;
  }
  for (const key of Object.keys(node)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) {
      err(
        `Schema at ${path || "<root>"} uses unsupported keyword "${key}". Allowed: ${[
          ...ALLOWED_SCHEMA_KEYS,
        ].join(", ")}.`
      );
    }
  }
  if (typeof node.type === "string" && !ALLOWED_TYPES.has(node.type)) {
    err(`Schema at ${path || "<root>"} uses unsupported type "${node.type}".`);
  }
  if (node.properties && typeof node.properties === "object") {
    for (const [k, v] of Object.entries(node.properties)) {
      walkSchema(v, `${path}.properties.${k}`);
    }
  }
  if (node.items) {
    walkSchema(node.items, `${path}.items`);
  }
}

function checkSchemaFile(path, label) {
  if (!existsSync(path)) {
    err(`${label} schema not found: ${path}`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    err(`${label} schema is not valid JSON: ${e.message}`);
    return null;
  }
  walkSchema(parsed, "");
  return parsed;
}

function validatePayload(schema, payload, path) {
  if (schema === null || typeof schema !== "object") return;

  if (typeof schema.type === "string") {
    const t = schema.type;
    const ok =
      (t === "object" &&
        payload !== null &&
        typeof payload === "object" &&
        !Array.isArray(payload)) ||
      (t === "array" && Array.isArray(payload)) ||
      (t === "string" && typeof payload === "string") ||
      (t === "number" && typeof payload === "number") ||
      (t === "integer" &&
        typeof payload === "number" &&
        Number.isInteger(payload)) ||
      (t === "boolean" && typeof payload === "boolean") ||
      (t === "null" && payload === null);
    if (!ok) {
      const got = Array.isArray(payload)
        ? "array"
        : payload === null
        ? "null"
        : typeof payload;
      err(`Payload at ${path || "<root>"} expected type ${t}, got ${got}.`);
      return;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(payload)) {
    err(
      `Payload at ${path || "<root>"} value ${JSON.stringify(payload)} not in enum ${JSON.stringify(schema.enum)}.`
    );
  }

  if (schema.type === "object" && payload && typeof payload === "object") {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in payload)) {
          err(`Payload at ${path || "<root>"} missing required key "${key}".`);
        }
      }
    }
    if (schema.properties && typeof schema.properties === "object") {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in payload) validatePayload(sub, payload[k], `${path}.${k}`);
      }
    }
  }

  if (schema.type === "array" && Array.isArray(payload) && schema.items) {
    payload.forEach((item, i) =>
      validatePayload(schema.items, item, `${path}[${i}]`)
    );
  }
}

function main() {
  const [, , appPath, inputSchemaPath, outputSchemaPath, payloadPath] =
    process.argv;

  if (!appPath || !inputSchemaPath || !outputSchemaPath) {
    console.error(
      "Usage: node test-app.mjs <App.tsx> <input.json> <output.json> [sample-payload.json]"
    );
    process.exit(2);
  }

  console.log(`Checking app:    ${appPath}`);
  checkAppFile(appPath);

  console.log(`Checking input:  ${inputSchemaPath}`);
  checkSchemaFile(inputSchemaPath, "Input");

  console.log(`Checking output: ${outputSchemaPath}`);
  const outputSchema = checkSchemaFile(outputSchemaPath, "Output");

  if (payloadPath) {
    console.log(`Validating payload: ${payloadPath}`);
    if (!existsSync(payloadPath)) {
      err(`Sample payload not found: ${payloadPath}`);
    } else {
      try {
        const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
        if (outputSchema) validatePayload(outputSchema, payload, "");
      } catch (e) {
        err(`Sample payload is not valid JSON: ${e.message}`);
      }
    }
  }

  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warn");

  if (warnings.length) {
    console.log("");
    for (const w of warnings) console.log(`warn:  ${w.message}`);
  }
  if (errors.length) {
    console.log("");
    for (const e of errors) console.log(`error: ${e.message}`);
    console.log(
      `\n${errors.length} error(s), ${warnings.length} warning(s).`
    );
    process.exit(1);
  }

  console.log(
    `\nOK — ${warnings.length} warning(s). Smoke test matches the platform import registry; keep the first label round small.`
  );
}

main();
