# Orizu apps — agent reference

You are reading the canonical reference for coding agents producing Orizu apps. Orizu apps are React/TSX components that render inside Orizu's task and preview screens to collect feedback from human reviewers: ratings, comments, comparisons, annotations, rankings, corrections, and agent-transcript review. This document covers everything needed to author a working app — runtime contract, conventions, design principles, the import registry, the per-component reference, recipes, and common pitfalls. Read top-to-bottom on first encounter; jump to specific sections by anchor afterwards.

If you are an external coding agent that found this via `orizu.ai/docs/llms.txt`, treat this document as the source of truth for both the runtime contract and the available primitives.

---

## TL;DR

You are writing a single TSX file. It must:

1. Use **named imports only**, and only from the paths in the **Imports** section below. There is no `npm install`; any other path fails at runtime with `Module not found`.
2. Export a **named** default function whose props are exactly `{ inputData, onComplete, initialValues }`.
3. Read the row to label from `inputData`. Pre-populate from `initialValues` if present.
4. When the reviewer finishes, call `onComplete(value)`. The value you pass is recorded as the response.

A complete, valid app:

```tsx
import { useState } from 'react';
import { StarRating } from '@/components/base/input/StarRating';
import { CommentBox } from '@/components/base/input/CommentBox';
import { Button } from '@/components/ui/button';

export default function Component({ inputData, onComplete, initialValues }) {
  const [rating, setRating] = useState(initialValues?.rating ?? 0);
  const [note, setNote] = useState(initialValues?.note ?? '');

  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-sm">{inputData.text}</p>
      <StarRating value={rating} onChange={setRating} />
      <CommentBox value={note} onChange={setNote} label="Why?" />
      <Button
        onClick={() => onComplete({ rating, note })}
        disabled={rating === 0}
      >
        Submit
      </Button>
    </div>
  );
}
```

---

## Runtime contract

Your default export receives three props from the Orizu runtime:

| Prop            | Type                | Meaning                                            |
|-----------------|---------------------|----------------------------------------------------|
| `inputData`     | object              | The current dataset row's payload (matches `input_json_schema`). |
| `onComplete`    | `(payload) => void` | Submit the annotation. Payload must match `output_json_schema`. |
| `initialValues` | object \| undefined | Previous response if the reviewer resumed; otherwise undefined. |

The validator rejects:

- **Anonymous default exports** such as `export default () => ...` or `export default memo(...)`. The default export must be a named function or class.
- **Default exports that destructure `data`** instead of `inputData`, or `onSubmit` instead of `onComplete`. The deprecated names fail validation at the app boundary.
- **Components that don't accept these props at all.**

You may use any other props internally (`useState`, `useReducer`, and so on); just keep the default export's signature exact.

### Output schema

`onComplete(payload)` is validated server-side against the pinned app version's `output_json_schema`. The validation surface is intentionally a **subset** of JSON Schema:

- `type` (`object`, `string`, `number`, `boolean`, `array`)
- `required`
- `properties`
- `items`
- `enum`

Anything else (`pattern`, `format`, `oneOf`, `anyOf`, `minLength`, …) is ignored or rejected. Keep schemas in this subset and have the component construct the payload literally — don't compute it at submit time from scattered state.

Both `input.json` and `output.json` are JSON Schema objects:

```json
{
  "type": "object",
  "properties": {
    "correctly_identified_issue": { "type": "boolean" },
    "escalated_when_required": { "type": "boolean" },
    "notes": { "type": "string" }
  },
  "required": ["correctly_identified_issue", "escalated_when_required"]
}
```

---

## App vs container ownership

The app component renders **one row at a time**. It does not navigate between rows, track queue position, persist drafts, or own session state. Those concerns belong to the platform's labeling container, which hydrates the app with a row's `inputData` (and any `initialValues` from a prior partial submission), then collects the response when the app calls `onComplete`.

| Concern                                                        | Owned by                |
|----------------------------------------------------------------|-------------------------|
| Rendering the current row                                      | **App**                 |
| Collecting and structuring the response                        | **App**                 |
| Internal UI state for the row (selections, drafts, validation) | **App**                 |
| Calling `onComplete(payload)` when ready                       | **App**                 |
| Queue position / "3 of 200"                                    | Container               |
| Submission confirmation / "saved!" toast                       | Container               |
| Navigation between rows (next / back)                          | Container               |
| Draft persistence across sessions                              | Container (via `initialValues`) |
| Auth, layout chrome, top/side bars                             | Container               |

Keep the app's job tight: show the row, collect the response, hand it back. Do not reimplement queue UI, custom saved toasts, or session state. In-row progress hints such as "3 of 5 questions answered" *are* fine — those describe the current row's state, not the container's.

---

## Compile & resolution model

- Your TSX is compiled server-side with **esbuild** to a CommonJS bundle. JSX is transformed to the automatic React runtime.
- Imports are resolved at runtime via a **fixed registry** (see Imports below). There is no `npm install`, no third-party packages, no deep paths beyond what is listed.
- An import path that isn't in the registry throws `Module not found: Cannot find module '<path>'` at render time. Always copy paths verbatim from the Imports section.
- React itself is auto-injected — `import React from 'react'` is allowed but not required. Hook imports like `import { useState } from 'react'` are fine.

---

## Use as-is, or inline a fork

When you reach for a component, you have exactly two paths. Make this decision deliberately for every primitive you use.

1. **Use as-is.** Import the registered component by name and pass the documented props. This is the default and the right answer for the vast majority of tasks. Wrapping the component in your own layout `div` for spacing, headings, or surrounding logic is still "use as-is" — the component itself is unchanged.

2. **Inline a private fork.** If the registered component's prop set or internal behaviour genuinely doesn't fit your task, fetch its source from the URL in the Component reference (every section has a `**Source:**` link), copy the implementation into your TSX file as a private component (e.g. `MyStarRating`), and adapt it. The runtime resolves imports against a fixed registry — you **cannot import a forked version** from any path the registry doesn't already expose, so any fork must live inline in the same file alongside your default export.

Read the source whenever a primitive almost-but-not-quite fits — it shows you the structure, the styling tokens, and the accessibility hooks already worked out, so your fork stays faithful to the design language. Inlining is a real, supported option, not a fallback to apologise for; just don't reach for it before checking whether composition or wrapping covers the case.

---

## Custom components

You aren't limited to the registered primitives. The TSX file can also declare any number of helper or composite components inline — standard React, no special framework requirements. Useful when the listed components don't cover your task or when you want a small, named abstraction for repeated structure.

### The default export contract is the only contract

Only one component in the file is bound by Orizu's contract: the default export. It must be a **named** function and accept exactly `{ inputData, onComplete, initialValues }`. Helper components defined alongside it have **no contract** — name them whatever you want, give them any prop shape, and call them from your default export like normal React.

```tsx
function QuestionRow({ id, label, value, onChange }) {
  // any prop shape, any name; not bound by the Orizu contract.
  return (
    <label className="flex items-center justify-between py-2">
      <span className="text-sm">{label}</span>
      <ThumbsRating value={value} onChange={(v) => onChange(id, v)} />
    </label>
  );
}

export default function Component({ inputData, onComplete, initialValues }) {
  // ...uses QuestionRow internally
}
```

### Building from scratch vs. forking a primitive

Two paths, both supported:

- **From scratch.** Write standard React, style with Tailwind utilities, keep imports inside the registry. No `npm install`, no third-party packages, no global CSS. Hooks like `useState`, `useReducer`, `useEffect` are available; pull them from `'react'`.
- **Forking a primitive.** Open the relevant component in the **Component reference** below, follow the `**Source:**` link to read the underlying TSX, copy the implementation into your file as a private component (e.g. `MyStarRating`), rename it, and adapt the internals. The runtime can't resolve a forked import path — any fork must live inline in the same file.

Either way, the rules below apply.

### What custom components must respect

- **Imports come from the registry only.** No deep paths beyond what is listed in the **Imports** section.
- **Style with Tailwind utilities and design tokens** (`text-foreground`, `text-muted-foreground`, `text-primary`, `text-destructive`). Don't override `app/globals.css` or rely on arbitrary Tailwind colors (`text-red-500`).
- **Stay accessible**: visible focus, semantic elements, labels above inputs, color isn't the only state signal.
- **The whole app ships in one TSX file** — no multi-file imports, no separate CSS modules, no asset imports.

If a helper grows large enough that you'd reach for a separate file, that's a signal to either (a) compose existing primitives differently, (b) inline-fork a primitive that's closer to what you want, or (c) request a new platform-level primitive rather than smuggling a multi-file pattern into a single file.

---

## Conventions

### Naming
- Components are PascalCase, named after what they ARE not what they DO. Prefer `StarRating` to `RateWithStars`.
- Boolean props: `isX` / `hasX`.
- Event handlers: `onX`.
- When a callback fires for a specific item, the id comes BEFORE the value: `onChange(id, value)`.

### Controlled inputs
Every input component is fully controlled. There are no `defaultValue` props. Always pass `value` and `onChange`. `readOnly` flattens visuals AND disables pointer/keyboard interaction.

### Reserved props
- `id` — required where listed; must be unique per render. Used by analytics and a11y helpers.
- `readOnly` — boolean. Used by interaction-disable helpers.

Do not repurpose these names for unrelated values.

### Styling
- Components are token-driven via Tailwind + CSS variables. Do not re-style components themselves — wrap them in a layout div if you need spacing or alignment.
- Use the standard Tailwind utility set inside your component. Custom CSS modules are not supported.
- Use design tokens (`text-foreground`, `text-muted-foreground`, `text-primary`, `text-destructive`) rather than arbitrary Tailwind colors (`text-red-500`).

### Never invent imports
Never invent a new import path; never rely on third-party packages. If a registered component doesn't fit, your two real options are spelled out under **Use as-is, or inline a fork** above — wrap, or copy the source inline.

---

## Mental model: components × behaviors

Pick a content component, pick a behavior, fill the slot. Examples:

- A `ConversationView` turn (content) wrapped in `Reactable` (behavior) whose `renderForm` slot holds a `CommentBox` (input) → per-turn thumbs with a reason field.
- A `TextContent` (content) wrapped in `Annotatable` (behavior) whose `renderAnnotation` slot holds a `TagPicker` (input) → span-level tagging.

The four roles:

- **Typography (`Prose`, `Prose.Body`, `Prose.H1`, etc.)** — what *you* write to frame the task: instructions, headings, helper copy. Lives outside the box.
- **Content (`TextContent`, `CodeBlock`, `ConversationView`, `ContentRenderer`)** — what the model produced or what's under review. Lives inside a box.
- **Behaviors (`Annotatable`, `Reactable`)** — wrap any content component to make it reviewable. They don't render content; they add affordances and slot in your input surface.
- **Input (`CommentBox`, `TagPicker`, `StarRating`, etc.)** — the surfaces you slot inside a behavior, or use directly to capture feedback.

---

## Design principles

A labeler is an interface annotators stare at for hours. It should feel like an app they want to use, not a form they tolerate. Treat the basics — type, color, spacing, hierarchy — as load-bearing, not decoration.

### Layout & visual hierarchy

- The data is the UI. Push the annotator's attention to the trace they're judging — minimize chrome around it.
- One container per logical region. Don't stack cards-inside-cards. Rely on whitespace and typography to separate sections, not nested borders.
- Visual hierarchy through size, weight, and position — not boxes, shadows, or gradients.
- Heavy shadows, tinted backgrounds, and busy gradients add visual noise without adding information. Stay flat or near-flat.
- Establish one focal point per screen. The annotator should always know where to look first.

### Typography

Legibility over personality. Annotators read for hours; the type system is doing the heavy lifting whether you notice it or not.

- **Two typefaces, max.** A proportional sans-serif for UI and prose; a monospace for code, JSON, tool calls, IDs. System font stacks (`-apple-system, ui-sans-serif, ...` and `ui-monospace`) are a perfectly good default — they're optimized for OS rendering and ship at zero weight cost. If you want a custom face, Inter, IBM Plex Sans, or Geist are reliable choices.
- **Keep the type scale small.** ~5 sizes total: 12 / 14 / 16 / 20 / 24 px. 16px is your prose default; 14px for dense UI; 12px reserved for metadata and footnotes.
- **Weight contrast > size contrast.** Use 500 / 600 weights for headers at the *same* size as body, rather than scaling up to 28–32px. Feels modern, saves vertical space, keeps the page calm.
- **Line height.** 1.5 for prose, 1.3 for UI labels and dense lists, 1.5–1.6 for code blocks. Tight code is hard to scan.
- **Line length.** Cap prose at 70–90 characters per line. Full-width text on a 27" display is unreadable.
- **Color contrast in type.** Body at full text color; secondary metadata at ~60% opacity (or a muted gray); never below ~4.5:1 contrast.
- Don't mix monospace and proportional inside a single inline run — it reads broken.

### Color

A muted, restrained palette beats a vibrant one for any tool people use professionally.

- **Neutrals carry the design.** 80–90% of the UI should be neutrals: a near-white background (or near-black in dark mode), one slightly off-tone surface for cards/panels, three or four gray text tones (primary, secondary, tertiary, disabled).
- **One accent color.** Pick one and use it for selection, focus rings, primary actions, and links. Resist the urge to introduce more.
- **Semantic colors only for state.** Green = pass / success. Red = fail / destructive. Amber = warn (use sparingly — most things are pass or fail). Don't use these as decoration or as the accent.
- **No category palettes.** If you need to distinguish many tags, roles, or types, use one color with text labels — not 8 distinct hues. Color is for state, not categorization.
- **Test in light and dark mode.** A design that only works on one is fragile.
- **Avoid opacity-as-color.** `text-black/40` for disabled or muted is fine; building a whole palette out of opacities falls apart on tinted backgrounds.

### Buttons & action hierarchy

- **One primary button per screen** (ideally per region). Filled, accent color, the single most-likely action — usually "Submit & next" or "Save."
- **Secondary actions are outlined or ghost.** "Skip," "back," "open notes." Visually quieter than primary; same height, different weight.
- **Tertiary actions are plain text or icon-only.** "Copy," "expand," "edit." No fill, no border.
- **Destructive actions are explicitly red**, never primary by default. Require a deliberate path — confirm modal for "delete row," hold-to-delete for inline destructive actions.
- **Buttons that are usually disabled are a smell.** Either the enabling condition is unclear, or the button shouldn't appear until the action is ready.
- **Size by importance, not whim.** Comfortable hit area for primary; slightly smaller secondary; inline-sized tertiary. Pick a small set of heights (e.g. 28 / 32 / 40 px) and stick to them.
- **Show the keyboard shortcut on the button itself** — `Submit ⏎`, `Skip (s)`. Tooltips are too easy to miss.

### Spacing & rhythm

- **Use a consistent scale.** 4 / 8 / 12 / 16 / 24 / 32 / 48 px (or equivalent). Don't pad with arbitrary values like 13px or 27px.
- **Whitespace where it aids parsing**, not as decoration. Tight clusters when things relate; gaps between unrelated regions.
- **Vertical rhythm.** Equal vertical spacing between siblings keeps the eye moving smoothly. Inconsistent spacing reads sloppy even when nothing else is wrong.
- **Border radius.** Pick one (4px or 6px reads modern; 8px is slightly softer; 12+ feels playful and is usually too much for a labeler) and use it everywhere.
- **Borders, not shadows.** A 1px subtle border separates regions cleanly. Shadows imply elevation, which a labeler rarely needs.

### Forms & inputs

- **Labels above inputs**, not beside. Easier to scan, works on every screen size, accessible by default.
- **Tap/click targets ≥ 32px tall.** Smaller feels cramped and hurts on touch.
- **Inline error states**, near the field. Don't summarize errors at the top of the form.
- **Placeholder is not a label.** Placeholder disappears when typing — use it for examples ("e.g. CASE-123456"), not for the field's name.
- **Auto-focus the primary field** on mount. Annotators shouldn't have to click to start.
- **Show character/token counts** only when there's a real limit; otherwise it's noise.
- **Inputs match button heights.** A 32px input next to a 40px button looks broken.

### Focus, hover, active states

- **Visible focus ring on every interactive element.** Keyboard users need to know what's focused. Don't suppress browser focus rings without replacing them — and replace them with something at least 2px and high-contrast.
- **Hover states are clear but subtle.** Slight background shift or border darken; not a wholesale color change.
- **Active states should feel tactile.** A 1–2px translate-y or a slight color darkening when pressed.
- **Disabled states must be obviously inert** — reduced opacity *and* no hover response.
- Design all four states (default, hover, focus, active) plus disabled for every interactive element. Missing states feel cheap.

### Iconography

- **One icon set.** Lucide, Phosphor, Heroicons — pick one and stay there. Mixing icon styles is jarring even when individuals look fine.
- **Consistent stroke weight** across the set. Most modern icon libraries get this right by default; don't break it by importing a stray icon from somewhere else.
- **Icons paired with text labels** for primary actions. Icons-only is fine for tertiary actions where space is tight and meaning is obvious (close, copy, expand, settings).
- **Same icon, same meaning** throughout the app. Don't reuse a checkmark for both "saved" and "selected."

### Motion & feedback

- **Animate state changes briefly** — 100–200ms with ease-out. Cross-fades between turns, slide-in for newly added notes.
- **Never animate purely for delight.** Each animation should communicate something — what changed, what's loading, what got selected.
- **Skeletons over spinners** for content loading. Spinners imply "wait"; skeletons imply "this is the shape of what's coming."
- **Immediate UI feedback** for in-row actions. A toggle should look "on" the instant the annotator clicks it; don't wait on any async work before showing the change.
- **Submission confirmation lives in the container**, not the app. The app's job ends at `onComplete` — don't render your own "saved!" toast.
- **Respect `prefers-reduced-motion`.** Cut transitions to instant for users who've opted out.

### Keyboard-first

Annotators move fast. Mouse-only flows cap throughput at maybe 1 label per 30 seconds; keyboard-driven flows hit 1 per 5 seconds.

- **Number keys** for quick choices (1/2/3 for pass/fail/skip; 1/2 for left/right in side-by-side).
- **j / k** for next / previous (or arrow keys).
- **Enter** to submit, **Esc** to clear or back out.
- Show the shortcut next to each interactive element on first encounter; fade after the annotator demonstrates fluency.
- Provide a `?` overlay listing every shortcut. Don't hide them in docs.

### Density without clutter

- Group related information close. Don't pad everything generously; use whitespace where it helps parse structure, not as decoration.
- A long trace shouldn't force scrolling past chrome to see content. Sticky or fixed elements should be earned.
- Truncate aggressively in summaries; expand on demand.

### Responsive without afterthought

- Wide screens get side-by-side or multi-column layouts; narrow screens stack. Same component, different breakpoint.
- Text columns shouldn't span the full width on a 27" display — cap line length around 70–90 characters for prose.
- Buttons and tap targets stay reachable on smaller laptops and tablets.

### State within the row

The container shows queue position and submission status — don't duplicate them in the app. What the app *should* communicate clearly is the state of the current row:

- **What's selected.** Active choices look obviously different from inactive ones — filled vs outlined, accent color vs neutral.
- **What's answered vs unanswered.** For multi-question forms, the difference between a deliberate "false" and "not answered yet" must be visible. A tristate (yes / no / unanswered) is fine; an undifferentiated toggle that defaults to "no" is not.
- **What's a draft.** If the annotator typed something but hasn't submitted, that text should look distinct from saved or pre-filled content (dashed border, subtle background, or a "draft" tag).
- **What just changed.** Animate the immediate consequence of an action briefly (100–200ms, ease-out). When a choice is selected, when an option appears, when validation flips. Never longer than 200ms — the annotator's next action shouldn't wait on motion.
- **What's required to submit.** If `onComplete` will be rejected (missing fields), make that obvious *before* submit — disable the action with an inline reason, or highlight the missing fields. Don't surface a server error after the fact.

### Avoid dead controls

- If a Likert slider rarely moves off the middle, you have a Likert problem. Replace with binary toggles.
- Free-text fields that nobody fills in should be removed or made obviously optional.
- Buttons that are usually disabled either need a clearer condition or shouldn't be there.

### Accessibility is throughput, not charity

- Every interactive element reachable by keyboard, with visible focus.
- Form controls have associated labels.
- Color is never the only signal — state is also indicated by icon, text, or position.
- Sufficient contrast for people labeling at 11pm with tired eyes (≥ 4.5:1 for body text, ≥ 3:1 for UI elements).

### What to leave out

- Tooltips that explain things the UI should already make obvious.
- Confirmation dialogs for reversible actions.
- Anything that duplicates container chrome — queue position, "saved" toasts, navigation arrows between rows.
- Decorative illustrations, mascots, or empty-state cartoons. Functional UIs don't need them.
- Multiple typefaces beyond your sans + mono pair. Don't add a "display" face for headings.
- Gradient text, glassmorphism, neon glows, animated backgrounds. They date instantly and add nothing.

---

## Common patterns by use case

Reach for these as starting points; adapt to your data.

### Agent trace exploration

The annotator needs to understand what the agent did, in order, before judging it.

- **Vertical timeline of turns/steps**, top-to-bottom, scrollable.
- Each turn collapsible; default state depends on length (short turns expanded, long turns collapsed with a one-line summary).
- **Role-coded by subtle left border or label**, not heavy colored backgrounds. User / Assistant / Tool / System are distinct enough with a 2px border + a small label.
- Tool calls and JSON in **monospace** with syntax-aware coloring; prose in proportional type.
- **Inline copy buttons** on tool args, IDs, and full turns.
- **Keyboard navigation:** `j` / `k` to jump between turns; `space` to expand/collapse the focused turn; `e` to expand all, `c` to collapse all.
- Per-turn metadata (latency, tokens) in a muted footer, not in the main body.
- If the annotator is judging a specific failure, **anchor the view** to the turn where it happens; don't make them scroll to find it.

### Side-by-side comparison

Two outputs from different prompts/models, annotator picks one (or ties).

- Two columns of equal width on wide screens; stacked on narrow.
- **Synced scrolling** — when the annotator scrolls one side, the other follows.
- **Hide identity until decision** (don't label which is "Model A" or "current prod"; reveal after the choice is locked). Removes anchoring bias.
- Three keys: `1` left wins, `2` right wins, `3` tie / both bad / neither.
- Optional **"why?" textarea** below the choice, only for ambiguous cases — don't force it on every label.
- For long outputs, **pin a one-line summary** of each side at the top; let the body scroll.
- **Diff highlighting** only when the comparison is small variation (same response, edited). For genuinely different responses, diff highlighting is noise.

### Text annotation (highlights + comments)

Annotator marks regions of a passage and attaches notes.

- Selected text gets a **subtle highlight** (low-opacity yellow or accent), not a heavy block.
- **Margin column on the right** with notes anchored to highlights on desktop; stack notes inline on narrow screens.
- **Hover-to-add** on selection; click-to-edit on existing notes.
- Distinct visual states for **draft vs. saved** notes (e.g. dashed outline vs. solid).
- Alternative panel: a **flat list of all notes** for quick triage / bulk-edit.
- **Keyboard:** `n` adds a note to the current selection; `↑` / `↓` cycles through notes; `enter` opens the focused note for edit.

### Multi-question binary form (most common labeler shape)

A trace + several pass/fail questions about it.

- Stack of toggles, **one question per row**, each a clear yes/no/unanswered.
- Numeric keys (`1`–`9`) **focus and toggle** the corresponding question.
- Per-question **optional notes**, hidden by default; expand on demand (don't show 8 empty textareas).
- **Per-row progress hint** ("3 of 5 answered" within this row's questions) is fine — this is in-row state, distinct from the container's queue position.
- Footer **submit** calls `onComplete` with the structured response; shortcut `enter`.
- `s` triggers an `onComplete` payload that marks the row unlabelable (e.g. `{ "skipped": true }`) — the container handles advancing.

### Free-form feedback (open-coding / error analysis)

Used early in the loop, before failure modes are formalized.

- **Hide rating widgets entirely.** This phase is qualitative.
- A single markdown-capable textarea per row.
- Below the textarea, optional **preset failure-mode tags** the annotator can attach — but never required.
- Show **previously-used tags** as quick-add chips so categorization emerges naturally.
- Don't force a category — trust the annotator to write.

### Multi-step agent step labeling

Annotator labels which step of a multi-step agent failed.

- **Timeline of steps** with state transitions visible (Plan → Search → Code → Finalize).
- Click a step to drill into a **side panel** with prompt, response, tool I/O.
- Per-step pass/fail toggle.
- **Highlight the first failed step** automatically (most upstream failures matter most; downstream errors are often consequences).
- Optional radio: **"this is where it went wrong"** (single-choice across steps) for cases where multiple steps failed but one is the root cause.

### Ranking

Annotator orders N candidates by quality.

- Drag-and-drop with keyboard equivalent (focus item, `↑` / `↓` to move).
- Numeric badges that update live as order changes.
- For N > 5, prefer **pairwise comparisons** over full ranking — annotators are unreliable at ordering long lists, and pairwise data composes via Bradley-Terry.

### Tool/function call audit

Annotator verifies an agent called the right tool with valid args.

- **Tool call** rendered as a structured card: name, args (monospace, expandable for big payloads), result.
- Three quick verdicts: `1` correct tool + correct args, `2` correct tool wrong args, `3` wrong tool.
- Optional textarea: "what would have been right?"
- For multi-tool sequences, show as a numbered list with verdicts per call.

---

## Imports

The complete set of allowed imports. Paths and exports are auto-generated from the runtime registry — every entry below resolves; nothing else does.

<!-- BEGIN ORIZU_AUTO_IMPORT_MAP -->
```tsx
// React hooks
import { useState, useRef, useEffect } from 'react';

// UI primitives (shadcn)
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Carousel } from '@/components/ui/carousel';
import { Checkbox } from '@/components/ui/checkbox';
import { Form } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableCaption, TableFooter } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Toggle } from '@/components/ui/toggle';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// Content
import { TextContent } from '@/components/base/content/TextContent';
import { CodeBlock } from '@/components/base/content/CodeBlock';
import { AssistantMessageBlock, ContextMessageBlock, ConversationMessageBlock, ConversationView, ReasoningMessageBlock, SystemMessageBlock, ToolCallBlock, ToolResultBlock, UserMessageBlock } from '@/components/base/content/ConversationView';
import { ContentRenderer } from '@/components/base/content/ContentRenderer';
import { Prose } from '@/components/base/content/Prose';

// Behaviors
import { Annotatable } from '@/components/base/behaviors/Annotatable';
import { Reactable } from '@/components/base/behaviors/Reactable';

// Input
import { CommentBox } from '@/components/base/input/CommentBox';
import { CriterionRating } from '@/components/base/input/CriterionRating';
import { LikertScale } from '@/components/base/input/LikertScale';
import { NumericRating } from '@/components/base/input/NumericRating';
import { RatingSelector } from '@/components/base/input/RatingSelector';
import { StarRating } from '@/components/base/input/StarRating';
import { TagPicker } from '@/components/base/input/TagPicker';
import { ThumbsRating } from '@/components/base/input/ThumbsRating';

// Base UI
import { ComparisonPanel } from '@/components/base/ui/ComparisonPanel';
import { DraggableItem } from '@/components/base/ui/DraggableItem';

// Templates
import { TagSelector } from '@/components/templates/classification/TagSelector';
import { SideBySideComparison } from '@/components/templates/comparison/SideBySideComparison';
import { CorrectionTask } from '@/components/templates/correction/CorrectionTask';
import { CodeComparison } from '@/components/templates/code/CodeComparison';
import { ContextualQA } from '@/components/templates/qa/ContextualQA';
import { RankingList } from '@/components/templates/ranking/RankingList';
import { SingleItemRater } from '@/components/templates/rating/SingleItemRater';
```
<!-- END ORIZU_AUTO_IMPORT_MAP -->

Use **named imports** for everything. Some registry entries support default imports for backwards compatibility, but named imports are the documented, portable form.

---

## Component reference

Each component below lists its source URL, import path, props, and a minimal usage example. Components flagged with a "**Source:**" link expose the underlying TSX at a stable URL — fetch that URL if you need to inline a private variant.

<!-- BEGIN ORIZU_AUTO_COMPONENT_REFERENCE -->
### Typography

Anything the coding agent writes themselves — instructions, headings, body copy. Lives outside the under-review box.

#### Prose {#prose}

Typography for anything the coding agent writes themselves — instructions, headings, body copy. Use this outside the under-review box; use TextContent inside it.

**Source:** [components/base/content/Prose.tsx](https://orizu.ai/docs/components/Prose/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { Prose } from "@/components/base/content/Prose"`

**Block primitives:**
- `Prose.Eyebrow` — Small mono uppercase label. Sits above an H1/H2.
- `Prose.H1 / H2 / H3` — Headings. Tight tracking, sans by default.
- `Prose.Lead` — Single deck-line under a heading. Larger than Body, lighter weight.
- `Prose.Body` — Standard paragraph. 14px / 1.6 line-height.
- `Prose.Small` — Helper / footnote. 12.5px.
- `Prose.Caption` — Mono caption under a figure or table. 11.5px.
- `Prose.Code` — Inline mono. Use inside a sentence, not as a block.
- `Prose.Link` — Documentary blue, underline preserved on hover.

**Props:**
- `children` * — `ReactNode` — <Prose> applies the type ramp to its children. Use the block primitives directly when you don’t want a wrapper.
- `className` — `string`

**Minimal usage:**

```jsx
<Prose
  children={<span />}
/>
```

### Content

The under-review primitives. What the model produced — text, code, conversation, media — framed inside a box. Wrap in behaviors to make reviewable.

#### TextContent {#textcontent}

The in-a-box content-under-review primitive. Plain text inside a frame. For prose the agent writes themselves, reach for Prose instead.

**Source:** [components/base/content/TextContent.tsx](https://orizu.ai/docs/components/TextContent/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { TextContent } from "@/components/base/content/TextContent"`

**Props:**
- `content` * — `string` — The text content to display.
- `maxHeight` — `string` (default: `"auto"`) — When set, content scrolls within this height.
- `isMonospace` — `boolean` (default: `false`) — Render in mono. Use for raw payloads, IDs, model output.
- `preformatted` — `boolean` (default: `false`) — Preserve whitespace (whitespace-pre-wrap).
- `variant` — `"default" | "mono" | "scrollable"` (default: `"default"`)
- `className` — `string` — Extra classes.

**Minimal usage:**

```jsx
<TextContent
  content={"..."}
/>
```

#### CodeBlock {#codeblock}

Numbered, scrollable code with optional line highlights and click handlers — the substrate for line-by-line review.

**Source:** [components/base/content/CodeBlock.tsx](https://orizu.ai/docs/components/CodeBlock/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { CodeBlock } from "@/components/base/content/CodeBlock"`

**Props:**
- `code` * — `string | CodeLine[]` — The code to display.
- `maxHeight` — `string` (default: `"400px"`) — Container height.
- `showLineNumbers` — `boolean` (default: `true`)
- `highlightedLines` — `number[]` (default: `[]`) — 1-indexed line numbers to highlight.
- `highlightClass` — `string` — Class applied to highlighted lines.
- `onLineClick` — `(n: number) => void` — Fires when a line is clicked.
- `onLineMouseDown` — `(n: number) => void` — For drag-select line ranges.
- `onLineMouseMove` — `(n: number) => void`
- `filename` — `string` — Optional chrome-strip filename.
- `language` — `string` — Optional chrome-strip language tag.

**Minimal usage:**

```jsx
<CodeBlock
  code={[]}
/>
```

#### SystemMessageBlock {#systemmessageblock}

Standalone system instruction renderer. Use it at the top of custom conversation layouts to show the governing prompt or policy context without taking the full transcript template. Wrap directly with Reactable or Annotatable for review.

**Source:** [components/base/content/ConversationBlocks.tsx](https://orizu.ai/docs/components/SystemMessageBlock/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { SystemMessageBlock } from "@/components/base/content/ConversationView"`

**Props:**
- `message` * — `Message & { role: "system" }` — A single system instruction message.
- `density` — `"comfortable" | "compact"` (default: `"comfortable"`)
- `showTimestamp` — `boolean` (default: `true`)
- `hideAvatar` — `boolean` (default: `false`)
- `className` — `string`

**Minimal usage:**

```jsx
<SystemMessageBlock
  message={{ id: "1", role: "system", content: "..." }}
/>
```

#### UserMessageBlock {#usermessageblock}

Standalone user turn renderer from the conversation system. Use it when an agent surface needs to place the user message outside the full transcript template.

**Source:** [components/base/content/ConversationBlocks.tsx](https://orizu.ai/docs/components/UserMessageBlock/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { UserMessageBlock } from "@/components/base/content/ConversationView"`

**Props:**
- `message` * — `Message & { role: "user" }` — A single user message.
- `density` — `"comfortable" | "compact"` (default: `"comfortable"`)
- `showTimestamp` — `boolean` (default: `true`)
- `hideAvatar` — `boolean` (default: `false`)
- `className` — `string`

**Minimal usage:**

```jsx
<UserMessageBlock
  message={{ id: "1", role: "user", content: "..." }}
/>
```

#### AssistantMessageBlock {#assistantmessageblock}

Standalone assistant turn renderer. Compose it with reactions, annotations, generated previews, or custom agent layouts without taking the full ConversationView.

**Source:** [components/base/content/ConversationBlocks.tsx](https://orizu.ai/docs/components/AssistantMessageBlock/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { AssistantMessageBlock } from "@/components/base/content/ConversationView"`

**Props:**
- `message` * — `Message & { role: "assistant" }` — A single assistant message.
- `density` — `"comfortable" | "compact"` (default: `"comfortable"`)
- `showTimestamp` — `boolean` (default: `true`)
- `hideAvatar` — `boolean` (default: `false`)
- `className` — `string`

**Minimal usage:**

```jsx
<AssistantMessageBlock
  message={{ id: "1", role: "assistant", content: "..." }}
/>
```

#### ReasoningMessageBlock {#reasoningmessageblock}

Standalone reasoning trace renderer. It keeps the existing default-collapsed details shell while letting agent UIs position reasoning independently. Wrap the block directly when reviewers need to react to or annotate the trace.

**Source:** [components/base/content/ConversationBlocks.tsx](https://orizu.ai/docs/components/ReasoningMessageBlock/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { ReasoningMessageBlock } from "@/components/base/content/ConversationView"`

**Props:**
- `message` * — `Message & { role: "reasoning" }` — A single reasoning trace. defaultOpen controls the details shell.
- `density` — `"comfortable" | "compact"` (default: `"comfortable"`)
- `showTimestamp` — `boolean` (default: `true`)
- `hideAvatar` — `boolean` (default: `false`)
- `className` — `string`

**Minimal usage:**

```jsx
<ReasoningMessageBlock
  message={{ id: "1", role: "reasoning", content: "..." }}
/>
```

#### ToolCallBlock {#toolcallblock}

Standalone tool-call renderer. It renders the tool name, optional badge, and collapsible args payload for trace panels and custom agent timelines. Wrap directly with Reactable or Annotatable before execution review.

**Source:** [components/base/content/ConversationBlocks.tsx](https://orizu.ai/docs/components/ToolCallBlock/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { ToolCallBlock } from "@/components/base/content/ConversationView"`

**Props:**
- `message` * — `Message & { role: "tool_call" }` — A single tool call. args is rendered before content when present.
- `density` — `"comfortable" | "compact"` (default: `"comfortable"`)
- `showTimestamp` — `boolean` (default: `true`)
- `hideAvatar` — `boolean` (default: `false`)
- `className` — `string`

**Minimal usage:**

```jsx
<ToolCallBlock
  message={{ id: "1", role: "tool_call", content: "..." }}
/>
```

#### ToolResultBlock {#toolresultblock}

Standalone tool-result renderer. It preserves the paired-result visual treatment while allowing callers to group, filter, react to, or annotate results themselves.

**Source:** [components/base/content/ConversationBlocks.tsx](https://orizu.ai/docs/components/ToolResultBlock/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { ToolResultBlock } from "@/components/base/content/ConversationView"`

**Props:**
- `message` * — `Message & { role: "tool_result" }` — A single tool result. result is rendered before content when present.
- `density` — `"comfortable" | "compact"` (default: `"comfortable"`)
- `showTimestamp` — `boolean` (default: `true`)
- `hideAvatar` — `boolean` (default: `false`)
- `className` — `string`

**Minimal usage:**

```jsx
<ToolResultBlock
  message={{ id: "1", role: "tool_result", content: "..." }}
/>
```

#### ConversationView {#conversationview}

Composed agentic transcript template built from SystemMessageBlock, UserMessageBlock, AssistantMessageBlock, ReasoningMessageBlock, ToolCallBlock, ToolResultBlock, and companion context blocks.

**Source:** [components/base/content/ConversationView.tsx](https://orizu.ai/docs/components/ConversationView/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { ConversationView } from "@/components/base/content/ConversationView"`

**Block primitives:**
- `SystemMessageBlock` — Top-of-transcript system instruction bubble for governing prompt or policy context.
- `UserMessageBlock` — Right-aligned user message bubble with avatar, label, and optional timestamp.
- `AssistantMessageBlock` — Assistant message bubble for direct composition with feedback and generated-output surfaces.
- `ReasoningMessageBlock` — Default-collapsed reasoning shell that can be mounted independently.
- `ToolCallBlock` — Collapsible tool-call payload with tool name and optional badge.
- `ToolResultBlock` — Collapsible tool-result payload with the paired result styling.

**Props:**
- `messages` * — `Message[]` — Each turn: { id, role, content, tool?, args?, result?, source?, timestamp?, duration?, avatar?, label?, badge?, defaultOpen? }. timestamp is an optional display string rendered verbatim. Roles: 'user' | 'assistant' | 'system' | 'reasoning' | 'tool_call' | 'tool_result' | 'context'.
- `density` — `"comfortable" | "compact"` (default: `"comfortable"`) — Compact halves the gap and tightens padding — use for long agentic traces.
- `showTimestamps` — `boolean` (default: `true`)
- `maxHeight` — `string` (default: `"300px"`)
- `scrollToBottom` — `boolean` (default: `true`)

**Minimal usage:**

```jsx
<ConversationView
  messages={[]}
/>
```

#### ContentRenderer {#contentrenderer}

For media (images, videos) and custom content types only. Don't use it for text — TextContent / CodeBlock / ConversationView do that better.

**Source:** [components/base/content/ContentRenderer.tsx](https://orizu.ai/docs/components/ContentRenderer/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { ContentRenderer } from "@/components/base/content/ContentRenderer"`

**Props:**
- `contentType` * — `"image" | "video" | "custom"`
- `content` * — `string | unknown` — URL for image/video, anything for custom.
- `maxHeight` — `string` (default: `"400px"`)
- `customRenderer` — `({ content }) => ReactNode` — Required when contentType="custom".

**Minimal usage:**

```jsx
<ContentRenderer
  contentType={"image"}
  content={"..."}
/>
```

### Behaviors

Wrap any content component to make it interactive. Behaviors don’t render content themselves — they add affordances and slot in whatever surface you compose.

#### Annotatable {#annotatable}

Wraps any child. Selection inside produces a span; renderAnnotation({span, save, cancel}) slot populates an anchored popover. The annotation surface is whatever you compose — CommentBox, TagPicker, RatingSelector, etc. Wraps TextContent, a ConversationView turn, or a CodeBlock the same way.

**Source:** [components/base/behaviors/Annotatable.tsx](https://orizu.ai/docs/components/Annotatable/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { Annotatable } from "@/components/base/behaviors/Annotatable"`

**Props:**
- `children` * — `ReactNode` — The component to make annotatable. Selection is captured inside its DOM subtree.
- `target` — `string` — Identifier for what is annotated (e.g. "msg:42").
- `annotations` — `AnnotationRecord<TData>[]` (default: `[]`) — Persisted annotations to render as highlights.
- `renderAnnotation` — `({ span, save, cancel }) => ReactNode` — Slot. Render the annotation surface; call save(payload) to commit, cancel() to discard.
- `onAnnotationCreate` — `({ target, span, data }) => void`
- `hideRail` — `boolean` (default: `false`) — Hide the inset guide rail.

**Minimal usage:**

```jsx
<Annotatable
  children={<span />}
/>
```

#### Reactable {#reactable}

Wraps any child. Adds an on-hover affordance rail (thumbs, flag, configurable). Optional renderForm captures context inline when a reaction is active.

**Source:** [components/base/behaviors/Reactable.tsx](https://orizu.ai/docs/components/Reactable/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { Reactable } from "@/components/base/behaviors/Reactable"`

**Props:**
- `children` * — `ReactNode`
- `target` — `string` — Identifier for what is reacted to.
- `types` — `("thumbs" | "flag")[]` (default: `["thumbs", "flag"]`) — The affordances on the rail.
- `value` — `ReactableValue | null` — The active reaction, if any.
- `renderForm` — `({ type, save, cancel }) => ReactNode` — Inline form opened when a reaction is selected. Slot in CommentBox, TagPicker, etc.
- `onReact` — `({ target, type, context }) => void`
- `onClear` — `(target?) => void`

**Minimal usage:**

```jsx
<Reactable
  children={<span />}
/>
```

### Input

Capture feedback. Rating selectors, comments, criterion ratings, tags. These are the surfaces you slot inside a behavior.

#### RatingSelector {#ratingselector}

One component, five rating mechanisms. Switch via the ratingType prop. Use this when you want the rating type to be configurable per task.

**Source:** [components/base/input/RatingSelector.tsx](https://orizu.ai/docs/components/RatingSelector/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { RatingSelector } from "@/components/base/input/RatingSelector"`

**Props:**
- `ratingType` * — `"numeric" | "likert" | "thumbs" | "stars" | "slider"`
- `value` * — `number | string | null`
- `onChange` * — `(value) => void`
- `minRating` — `number` (default: `1`)
- `maxRating` — `number` (default: `5`)
- `likertLabels` — `string[]` (default: `["Strongly Disagree", … "Strongly Agree"]`)

**Minimal usage:**

```jsx
<RatingSelector
  ratingType={"numeric"}
  value={0}
  onChange={() => {}}
/>
```

#### StarRating {#starrating}

Hover-previewed star rating with configurable scale and active color.

**Source:** [components/base/input/StarRating.tsx](https://orizu.ai/docs/components/StarRating/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { StarRating } from "@/components/base/input/StarRating"`

**Props:**
- `value` * — `number`
- `maxRating` — `number` (default: `5`)
- `minRating` — `number` (default: `1`)
- `readOnly` — `boolean` (default: `false`)
- `size` — `string | number` (default: `"1.5rem"`)
- `activeColor` — `string` (default: `"text-primary"`)
- `inactiveColor` — `string` (default: `"text-border"`)
- `onChange` — `(rating: number) => void`

**Minimal usage:**

```jsx
<StarRating
  value={0}
/>
```

#### NumericRating {#numericrating}

Row of numbered buttons. The most legible scale at a glance — pick this when accuracy matters more than speed.

**Source:** [components/base/input/NumericRating.tsx](https://orizu.ai/docs/components/NumericRating/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { NumericRating } from "@/components/base/input/NumericRating"`

**Props:**
- `value` * — `number | null`
- `minRating` — `number` (default: `1`)
- `maxRating` — `number` (default: `5`)
- `size` — `"sm" | "md" | "lg"` (default: `"md"`)
- `readOnly` — `boolean` (default: `false`)
- `onChange` — `(rating: number) => void`

**Minimal usage:**

```jsx
<NumericRating
  value={0}
/>
```

#### ThumbsRating {#thumbsrating}

Binary feedback. Three visual styles (filled / outline / icon) and an optional minimal mode for compact UIs.

**Source:** [components/base/input/ThumbsRating.tsx](https://orizu.ai/docs/components/ThumbsRating/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { ThumbsRating } from "@/components/base/input/ThumbsRating"`

**Props:**
- `value` * — `"up" | "down" | null`
- `onChange` — `(value: "up" | "down") => void`
- `size` — `"sm" | "md" | "lg"` (default: `"md"`)
- `selectedStyle` — `"filled" | "outline" | "icon"` (default: `"filled"`)
- `minimal` — `boolean` (default: `false`) — No button background, just colored icons.
- `showLabels` — `boolean` (default: `false`)
- `upText` — `string` (default: `"Like"`)
- `downText` — `string` (default: `"Dislike"`)
- `readOnly` — `boolean` (default: `false`)

**Minimal usage:**

```jsx
<ThumbsRating
  value={"up"}
/>
```

#### LikertScale {#likertscale}

Ordered radio scale with custom labels. Horizontal by default; verticalize for long labels.

**Source:** [components/base/input/LikertScale.tsx](https://orizu.ai/docs/components/LikertScale/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { LikertScale } from "@/components/base/input/LikertScale"`

**Props:**
- `value` * — `string | null`
- `labels` * — `string[]`
- `horizontal` — `boolean` (default: `true`)
- `readOnly` — `boolean` (default: `false`)
- `onChange` — `(value: string) => void`

**Minimal usage:**

```jsx
<LikertScale
  value={"..."}
  labels={[]}
/>
```

#### CriterionRating {#criterionrating}

A single bordered criterion (label + optional collapsible description) with a horizontal radio group. Stack several inside a comparison panel.

**Source:** [components/base/input/CriterionRating.tsx](https://orizu.ai/docs/components/CriterionRating/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { CriterionRating } from "@/components/base/input/CriterionRating"`

**Props:**
- `id` * — `string`
- `label` * — `string`
- `description` — `string` — Shown when expanded; collapses behind a chevron.
- `value` * — `string | null`
- `options` * — `{ value, label }[]` — Typically [{value:"left"}, {value:"right"}, {value:"tie"}].
- `initiallyExpanded` — `boolean` (default: `false`)
- `readOnly` — `boolean` (default: `false`)
- `onChange` — `(id, value) => void`

**Minimal usage:**

```jsx
<CriterionRating
  id={"..."}
  label={"..."}
  value={"..."}
  options={[]}
/>
```

#### CommentBox {#commentbox}

Multiline text input with label, instructions, validation (min/max length), and optional character count.

**Source:** [components/base/input/CommentBox.tsx](https://orizu.ai/docs/components/CommentBox/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { CommentBox } from "@/components/base/input/CommentBox"`

**Props:**
- `value` * — `string`
- `onChange` — `(value: string) => void`
- `label` — `string`
- `instructions` — `string` — Helper paragraph under the label.
- `placeholder` — `string` (default: `"Enter your comment here..."`)
- `rows` — `number` (default: `3`)
- `maxLength` — `number` (default: `0`) — 0 disables the cap.
- `minLength` — `number` (default: `0`) — Validation triggers on blur.
- `showCharCount` — `boolean` (default: `false`)
- `error` — `string` — Shown after blur.
- `readOnly` — `boolean` (default: `false`)

**Minimal usage:**

```jsx
<CommentBox
  value={"..."}
/>
```

#### TagPicker {#tagpicker}

Pill-shaped tag selector. Single or multi-select, optional category grouping, optional custom-tag input.

**Source:** [components/base/input/TagPicker.tsx](https://orizu.ai/docs/components/TagPicker/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { TagPicker } from "@/components/base/input/TagPicker"`

**Props:**
- `availableTags` * — `Tag[]` — { id, label, category?, description?, color? }
- `selectedTagIds` * — `string[]`
- `multiSelect` — `boolean` (default: `true`)
- `allowCustomTags` — `boolean` (default: `false`)
- `groupByCategory` — `boolean` (default: `false`)
- `customTagPlaceholder` — `string` (default: `"Add a custom tag..."`)
- `readOnly` — `boolean` (default: `false`)
- `onTagsChange` — `(ids: string[]) => void`
- `onCustomTagAdd` — `(label: string) => void`

**Minimal usage:**

```jsx
<TagPicker
  availableTags={[]}
  selectedTagIds={[]}
/>
```

### UI

Layout pieces used by templates.

#### ComparisonPanel {#comparisonpanel}

Card with a labeled header bar — the left/right wells of any side-by-side comparison.

**Source:** [components/base/ui/ComparisonPanel.tsx](https://orizu.ai/docs/components/ComparisonPanel/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { ComparisonPanel } from "@/components/base/ui/ComparisonPanel"`

**Props:**
- `label` * — `string`
- `children` * — `ReactNode`
- `description` — `string`
- `isSelected` — `boolean` (default: `false`) — Applies highlightClass.
- `highlightClass` — `string` — Override selection class.
- `badge` — `ReactNode` — Top-right pill (e.g. comment count).
- `height` — `string` (default: `"auto"`)
- `onClick` — `() => void`

**Minimal usage:**

```jsx
<ComparisonPanel
  label={"..."}
  children={<span />}
/>
```

#### DraggableItem {#draggableitem}

A row that supports both native drag-and-drop and explicit up/down buttons. The atom of a RankingList.

**Source:** [components/base/ui/DraggableItem.tsx](https://orizu.ai/docs/components/DraggableItem/source) — fetch this URL to read the implementation, or to copy it inline as a private fork if the registered props don't fit your task.

**Import:** `import { DraggableItem } from "@/components/base/ui/DraggableItem"`

**Props:**
- `id` * — `string`
- `children` * — `ReactNode`
- `rank` — `number` (default: `0`)
- `maxRank` — `number` (default: `0`)
- `isDragging` — `boolean` (default: `false`)
- `isDraggedOver` — `boolean` (default: `false`)
- `showControls` — `boolean` (default: `true`)
- `disableControls` — `boolean` (default: `false`)
- `onDragStart` — `(id) => void`
- `onDragOver` — `(id) => void`
- `onDrop` — `(id) => void`
- `onDragEnd` — `() => void`
- `onMoveUp` — `(id) => void`
- `onMoveDown` — `(id) => void`

**Minimal usage:**

```jsx
<DraggableItem
  id={"..."}
  children={<span />}
/>
```

### Recipes

Worked component + behavior compositions. Read these before building — the mental model is pick a component, pick a behavior, fill the slot.

#### Composition recipes {#composition-recipes}

Worked behavior × component patterns. The mental model: pick an individual content block, pick a behavior, fill the slot.

**Recipe 1 — Flag a tool call before it executes**
Why: Reactable wraps the tool_call turn; the rail offers ‘flag’; the form captures why before letting the agent run.

```jsx
const [flagReason, setFlagReason] = useState("")

<Reactable
  types={["flag"]}
  renderForm={({ save, cancel }) => (
    <div className="space-y-2">
      <CommentBox
        label="Why is this call wrong?"
        value={flagReason}
        onChange={setFlagReason}
      />
      <div className="flex gap-2">
        <Button onClick={() => save(flagReason)} disabled={!flagReason.trim()}>
          Save
        </Button>
        <Button variant="outline" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  )}
  onReact={recordReaction}
>
  <ToolCallBlock
    message={{ id: "1", role: "tool_call", tool: "send_email", content: "..." }}
  />
</Reactable>
```

**Recipe 2 — Annotate a system instruction**
Why: Annotatable wraps the standalone system block at the top of a custom conversation layout, so reviewers can mark the exact policy phrase that made the run too constrained.

```jsx
const [annotationText, setAnnotationText] = useState("")

<Annotatable
  annotations={existing}
  renderAnnotation={({ span, save, cancel }) => (
    <div className="space-y-2">
      <CommentBox
        label={`On "${span.text}"`}
        value={annotationText}
        onChange={setAnnotationText}
      />
      <div className="flex gap-2">
        <Button
          onClick={() => save({ comment: annotationText })}
          disabled={!annotationText.trim()}
        >
          Save
        </Button>
        <Button variant="outline" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  )}
  onAnnotationCreate={appendAnnotation}
>
  <SystemMessageBlock
    message={{ id: "1", role: "system", content: "Use only verified context." }}
  />
</Annotatable>
```

**Recipe 3 — Per-turn thumbs with optional note**
Why: Reactable on each assistant turn. Thumbs are the rail; renderForm only opens for thumbs-down to capture a reason.

```jsx
const [note, setNote] = useState("")

<Reactable
  types={["thumbs"]}
  renderForm={({ type, save, cancel }) =>
    type === "thumbs_down" ? (
      <div className="space-y-2">
        <CommentBox
          label="What was wrong?"
          value={note}
          onChange={setNote}
        />
        <div className="flex gap-2">
          <Button onClick={() => save(note)} disabled={!note.trim()}>
            Save
          </Button>
          <Button variant="outline" onClick={cancel}>
            Cancel
          </Button>
        </div>
      </div>
    ) : null
  }
  onReact={saveReaction}
>
  <AssistantMessageBlock
    message={{ id: "1", role: "assistant", content: "..." }}
  />
</Reactable>
```

**Recipe 4 — Annotate spans inside a reasoning trace**
Why: Annotatable wraps the reasoning turn; selection inside captures a span; the slot is a CommentBox so reviewers can call out a wrong inference at the exact phrase.

```jsx
const [annotationText, setAnnotationText] = useState("")

<Annotatable
  annotations={existing}
  renderAnnotation={({ span, save, cancel }) => (
    <div className="space-y-2">
      <CommentBox
        label={`On "${span.text}"`}
        value={annotationText}
        onChange={setAnnotationText}
      />
      <div className="flex gap-2">
        <Button
          onClick={() => save({ comment: annotationText })}
          disabled={!annotationText.trim()}
        >
          Save
        </Button>
        <Button variant="outline" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  )}
  onAnnotationCreate={appendAnnotation}
>
  <ReasoningMessageBlock
    message={{ id: "1", role: "reasoning", content: "...", defaultOpen: true }}
  />
</Annotatable>
```

**Recipe 5 — React to a tool result**
Why: Reactable wraps the standalone tool result, so reviewers can thumbs-down or flag bad evidence without reacting to the whole conversation.

```jsx
const [note, setNote] = useState("")

<Reactable
  types={["thumbs", "flag"]}
  renderForm={({ save, cancel }) => (
    <div className="space-y-2">
      <CommentBox
        label="What is wrong with this result?"
        value={note}
        onChange={setNote}
      />
      <div className="flex gap-2">
        <Button onClick={() => save(note)} disabled={!note.trim()}>
          Save
        </Button>
        <Button variant="outline" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  )}
  onReact={recordReaction}
>
  <ToolResultBlock
    message={{ id: "1", role: "tool_result", tool: "search_docs", content: "..." }}
  />
</Reactable>
```
<!-- END ORIZU_AUTO_COMPONENT_REFERENCE -->

---

## Core type shapes

These are the shapes most agents need when composing the primitives. The runtime does not require you to declare these interfaces, but matching them avoids bad callback names and invalid reaction values.

```ts
type MessageRole =
  | 'user'
  | 'assistant'
  | 'system'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'context';

interface Message {
  id: string;
  role: MessageRole;
  content: string;
  tool?: string;
  args?: unknown;
  result?: unknown;
  source?: string;
  timestamp?: string;
  duration?: string;
  avatar?: React.ReactNode;
  label?: string;
  badge?: React.ReactNode;
  defaultOpen?: boolean;
}

type ReactionType = 'thumbs_up' | 'thumbs_down' | 'flag';

interface AnnotationSpan {
  startOffset: number;
  endOffset: number;
  text: string;
}

interface AnnotationRecord<TData = unknown> {
  id: string;
  span: AnnotationSpan;
  data: TData;
  createdAt: Date | string;
  updatedAt?: Date | string;
  hoverContent?: React.ReactNode;
}

interface Tag {
  id: string;
  label: string;
  category?: string;
  description?: string;
  color?: string;
}
```

---

## Common pitfalls (do NOT do these)

- ❌ `import StarRating from '@/components/base/input/StarRating'` — default imports are not consistently available. Use `{ StarRating }`.
- ❌ `import { Heart } from 'lucide-react'` — third-party packages aren't in the registry. If you need an icon, use one already imported by a component you're rendering, or use Unicode (★, ✓, ↗).
- ❌ `import { Foo } from '@/components/base/content/Foo'` for any `Foo` not in the Imports section — runtime throws `Module not found`.
- ❌ Using `data` or `onSubmit` as the root component prop names — must be `inputData` and `onComplete`.
- ❌ Anonymous default exports (`export default () => …`, `export default memo(…)`). Use a named function.
- ❌ Calling `onComplete` more than once per row, or never calling it.
- ❌ Mutating `inputData` or `initialValues`. Treat them as immutable.
- ❌ Adding global CSS or modifying `app/globals.css`. Style with Tailwind utilities inside your component only.
- ❌ `<TextContent>{children}</TextContent>` — TextContent takes a `content` string prop, not children.
- ❌ Re-styling primitives' colors with arbitrary Tailwind values (`text-red-500`). Use the design tokens (`text-foreground`, `text-muted-foreground`, `text-primary`, `text-destructive`).
- ❌ Schema features beyond the supported subset (`pattern`, `format`, `oneOf`, `anyOf`, `minLength`). They will be ignored or rejected.
- ❌ Multi-point Likert scales for binary judgments — annotators on Likert collapse to the middle. Use multiple binary fields.

---

## Validating before publish

Customers can validate a generated file before publishing it via the CLI app publish endpoints, including `POST /api/cli/apps/create-from-file` and `POST /api/cli/apps/[id]/update-from-file`. These endpoints run the same validator and esbuild pipeline used at render time. If validation fails, errors describe exactly which rule was violated. Use this in your agent's CI step if you have one.

### Offline smoke test

Before `orizu apps create`, run the smoke test that ships with this skill:

```bash
node /path/to/orizu-cli-skill/scripts/test-app.mjs \
  ./labeler/App.tsx \
  ./labeler/input.json \
  ./labeler/output.json \
  ./labeler/sample-payload.json   # optional
```

What it checks:
- File parses, has a single named default export.
- Default export's signature destructures `inputData`, `onComplete`, `initialValues` (and not the deprecated names).
- `input.json` and `output.json` use only the supported validation surface (`type`, `required`, `properties`, `items`, `enum`).
- If a `sample-payload.json` is provided, it validates against `output.json`.

What it doesn't check:
- Server-side persistence and project authorization. Those still happen during `orizu apps create`.

### Local Playwright preview

Before publishing, render the app with the local CLI preview:

```bash
orizu apps preview \
  --file ./labeler/App.tsx \
  --input-schema ./labeler/input.json \
  --output-schema ./labeler/output.json \
  --sample-row ./labeler/sample-row.json \
  --screenshot ./labeler/preview.png
```

The command validates the same app contract and allowed import registry as upload, validates the sample row against `input.json`, serves a temporary static preview page, passes `inputData`, `initialValues`, and `onComplete`, then uses Playwright to render it. Add `--headed` for visible Chromium review, and `--keep-open` when you want to inspect the local page manually. In the Orizu web checkout, preview uses the live component tree and global Tailwind CSS; in the mirrored/published CLI package, it uses the bundled preview runtime snapshot so the workflow remains available without the site source tree.

For coding agents: do not treat a passing contract check as enough. After generating or editing an app, run `orizu apps preview` with a representative row, inspect the screenshot, and compare the rendered workflow to the user's likely intent: are the right fields visible, is the primary judgment obvious, do controls fit, and would a human reviewer know what to do? If the screenshot looks wrong, revise the app and preview again before publishing.

---

## Pre-publish checklist

Before `orizu apps create`:

- [ ] Default export is a named function/class
- [ ] Props are exactly `inputData`, `onComplete`, `initialValues`
- [ ] Schemas use only the supported validation subset
- [ ] Keyboard shortcuts cover the primary actions
- [ ] Layout reflows on narrow screens
- [ ] App calls `onComplete` with the full response payload; no custom save state in the app
- [ ] `?` shortcut overlay or visible cheat sheet
- [ ] Smoke test passes (`node scripts/test-app.mjs ...`)
- [ ] Local preview renders and screenshot is inspected against the user's intended workflow (`orizu apps preview ... --screenshot preview.png`)
