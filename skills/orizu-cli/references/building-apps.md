# Building Apps

How to author a labeler app for Orizu — the custom UI annotators use to label dataset rows. The output of a labeling task is only as good as the interface that produced it; treat the app as a real product, not a form.

## Contract

Apps are React components compiled and served by the Orizu platform. Three things define the contract.

### 1. Default export, named

The file must have a single default export that's a **named** function or class:

```tsx
export default function SupportLabeler({ inputData, onComplete, initialValues }) { ... }
```

Anonymous wrappers (`export default () => ...`, `export default memo(...)`) are not supported.

### 2. Three props, exact names

The component receives **exactly** these props:

| Prop            | Type                | Meaning                                            |
|-----------------|---------------------|----------------------------------------------------|
| `inputData`     | object              | The current dataset row's payload (matches `input_json_schema`). |
| `onComplete`    | `(payload) => void` | Submit the annotation. Payload must match `output_json_schema`. |
| `initialValues` | object \| undefined | Previous response if the annotator resumed; otherwise undefined. |

Deprecated names that **fail validation**: `data`, `onSubmit`. Don't use them.

### 3. Output validates against `output_json_schema`

`onComplete(payload)` is validated server-side against the pinned app version's output schema.

The validation surface is a **subset** of JSON Schema:

- `type` (`object`, `string`, `number`, `boolean`, `array`)
- `required`
- `properties`
- `items`
- `enum`

Anything else (`pattern`, `oneOf`, `format`, `minLength`, …) will be ignored or rejected. Keep schemas in this subset.

### Schemas

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

### Allowed runtime surface

The platform exposes a curated set of UI primitives (shadcn-style components, common form controls, layout helpers, code/text rendering blocks, comparison and ranking templates) plus Tailwind utility classes. **No external npm imports.** Use what's exposed; if you need something that isn't, request it as a platform addition rather than working around it.

---

## What the app owns vs what the container owns

The app component renders **one row at a time**. It does not navigate between rows, track queue position, persist drafts, or own session state. Those concerns belong to the platform's labeling container, which hydrates the app with a row's `inputData` (and any `initialValues` from a prior partial submission), then collects the response when the app calls `onComplete`.

| Concern                                  | Owned by                |
|------------------------------------------|-------------------------|
| Rendering the current row                | **App**                 |
| Collecting and structuring the response  | **App**                 |
| Internal UI state for the row (selections, drafts, validation) | **App** |
| Calling `onComplete(payload)` when ready | **App**                 |
| Queue position / "3 of 200"              | Container               |
| "Saved" / submission status              | Container               |
| Navigation between rows (next / back)    | Container               |
| Draft persistence across sessions        | Container (via `initialValues`) |
| Auth, layout chrome, top/side bars       | Container               |

When designing, keep the app's job tight: show the row, collect the response, hand it back. Don't reimplement queue UI or session state — the container provides them.

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
- **Test in light and dark mode.** A design that only works on one is fragile. Run the labeler in both before shipping; check that the accent stays legible on both surfaces.
- **Avoid opacity-as-color.** `text-black/40` for disabled or muted is fine; building a whole palette out of opacities falls apart on tinted backgrounds.

### Buttons & action hierarchy

Annotators have many things they *could* do on each screen. Clear hierarchy makes the right next action obvious.

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

- If a Likert slider rarely moves off the middle, you have a Likert problem (see `primer.md` Step 2). Replace with binary toggles.
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

## Offline smoke test

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
- Server-side compilation parity. Some failures only surface after upload — keep your first label round small.
- Runtime behavior. Mount the component in a sandbox if you want render-level testing.

---

## Common pitfalls

- **Wrong prop names.** `data` and `onSubmit` are deprecated and fail validation. Use `inputData` and `onComplete`.
- **Schema features that won't validate.** Sticking to `type / required / properties / items / enum` keeps you safe; `pattern`, `format`, `oneOf`, etc. won't be enforced.
- **Submitting payloads that don't match the schema.** Keep `output_json_schema` simple, and have the component construct its payload literally — don't compute it at submit time from scattered state.
- **Heavy chrome that hides the data.** Strip cards, shadows, and padding until the trace is the loudest thing on the screen.
- **No keyboard shortcuts.** Single biggest throughput multiplier; ship them from the first version.
- **Multiple ratings per question.** Annotators on Likert collapse to the middle. Prefer binary; use multiple binary questions for multidimensional judgments.

---

## Checklist

Before `orizu apps create`:

- [ ] Default export is a named function/class
- [ ] Props are exactly `inputData`, `onComplete`, `initialValues`
- [ ] Schemas use only the supported validation subset
- [ ] Keyboard shortcuts cover the primary actions
- [ ] Layout reflows on narrow screens
- [ ] App calls `onComplete` with the full response payload; no custom save state in the app
- [ ] `?` shortcut overlay or visible cheat sheet
- [ ] Smoke test passes (`node scripts/test-app.mjs ...`)
