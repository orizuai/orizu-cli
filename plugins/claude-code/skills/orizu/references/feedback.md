# Product feedback

File product feedback when Orizu itself gets in the way while you work on a customer's behalf. This covers the CLI, the installed skill, the docs, and the method; friction and frustration count even when the work eventually succeeds.

## Choose a category

- `bug` — a command failed or did the wrong thing.
- `docs` — the skill or docs disagree with what the CLI does.
- `missing` — a capability Orizu does not have blocks or limits the work.
- `guidance` — the method left you not knowing what to do next.
- `friction` — it worked but was confusing, slow, or annoying.
- `other` — an Orizu problem does not fit the categories above.

## Choose a severity

- `blocking` — could not continue.
- `major` — continued with a workaround that cost real time or a worse result.
- `minor` — worth fixing; did not slow the work.

Choose severity by what the problem cost this work. It is your claim; the Orizu team can re-rank it during review.

## Keep customer content out

Never put instruction-set text, dataset rows, traces, model or application outputs, judge inputs, or judge outputs in any field or attachment. Describe the Orizu problem instead: name the command or method step, what Orizu did, what you expected, and how that affected the work without quoting customer content.

Secrets and personal data are scrubbed as defence in depth, not as permission to include customer content. Attach only small diagnostic text files that obey the same rule.

A valid last-error record from the previous 24 hours is attached automatically when its recorded server and team match the report context. A record with no recorded origin—written before locators existed or by a command that never resolved a server—is attached too. Pass `--no-last-error` to keep either kind out; use it unless the report is about the command that failed and that command did not handle customer content.

## File it

Before filing, run `orizu --version` and `orizu capabilities --json`. Check that capabilities lists `feedback`. If `feedback` is absent, tell the user to run `npm i -g orizu`. Then tell them to run `npx orizu setup`. Do not file product feedback.

Use this complete command surface; omit optional narrative fields that add no useful context, repeat `--attach` for multiple allowed files, and add `--json` when machine-readable output is needed.

    orizu feedback --category <category> --severity <severity> --summary <summary> --tried <tried> --expected <expected> --actual <actual> --impact <impact> --repro <repro> --attach <path> --from-file <path> --project <team/project> --no-last-error --json

Value flags accept `--flag value` and `--flag=value`; use the equals form for values that begin with `-`. `--category`, `--severity`, `--summary`, and `--actual` are required unless `--from-file` supplies them. `--from-file` accepts one JSON object whose only keys are `category`, `severity`, `summary`, `tried`, `expected`, `actual`, `impact`, and `repro`; each value is a string or null, and any other key produces `invalid_from_file_json`. Use `--impact` to say how a fix helps this customer and others. `--project <team/project>` supplies feedback context when the current directory is not an Orizu workspace.

The CLI adds environment context.

Field caps are `summary` 200 bytes, `actual` 1,200 bytes, `tried` 800 bytes, `expected` 800 bytes, `impact` 800 bytes, and `repro` 1,200 bytes; all narrative fields together stay within 4,000 bytes total. Attach at most 5 `.log`, `.txt`, `.md`, or `.json` files of 256 KiB each. When `--attach` has no team context from `--project`, `ORIZU_PROJECT`, or the workspace manifest, the CLI refuses before opening a file: `invalid_attachments: attachments need a project: pass --project <team/project> or set ORIZU_PROJECT`. Only on a narrative or attachment `too_large_*` refusal, shorten or drop the offending field or attachment and refile once; `too_large_environment` follows its per-code recovery; for `invalid_*`, follow the per-code recovery in `references/cli-reference.md` to choose a valid value, repair the file, or upgrade and rerun; on `rate_limited`, stop and mention it in the final report. For every other code, follow the recovery table in `references/cli-reference.md`. `storage_failed` confirms that nothing was stored; retry once after a pause, or email feedback@orizu.ai. After `feedback_timeout` or any other 5xx response, do not resend the same report: storage is unconfirmed and the request has no idempotency key; email feedback@orizu.ai instead.

File autonomously once the report is specific and contains no excluded customer content. When a person is present, tell them what you filed after sending it; their approval is not a prerequisite.

## Worked examples

### Bug after a failed command

A valid dataset upload failed inside an Orizu workspace. Because the failed command handled customer content, keep its last-error record out and describe the consequence rather than copying the error:

    orizu feedback \
      --category bug \
      --severity major \
      --summary "Dataset upload rejected a valid JSONL file" \
      --tried "Validated the file and retried with an explicit project" \
      --expected "The validated rows would upload" \
      --actual "The upload command exited before creating the dataset" \
      --impact "A clearer refusal or successful upload would avoid a manual import workaround" \
      --no-last-error

With `--no-last-error`, the last-error record stays out of this filing.

### Guidance with no error

The CLI worked, but the method did not identify the safe next step:

    orizu feedback \
      --category guidance \
      --severity minor \
      --summary "The method did not say which evidence to gather next" \
      --expected "The flow would name the next evidence boundary" \
      --actual "The flow ended with two plausible next steps and no selection rule" \
      --impact "A selection rule would keep agents from guessing" \
      --no-last-error

The flag keeps any unrelated recent failure out of this report.

## After filing

Human-readable success looks like:

```text
Reported (id <uuid>). Thanks, this has been reported. To follow up, email feedback@orizu.ai
```

With `--json`, expect the same report id and acknowledgement as one JSON object:

    {"id":"<uuid>","message":"Thanks, this has been reported. To follow up, email feedback@orizu.ai"}

Refusals go to stderr with a non-zero exit status and leave stdout empty; notices are stderr lines that can accompany a success.

Do not expose or invent a Linear link.

If authentication is unavailable, the command exits unsuccessfully with:

```text
unauthenticated: Sign in first (orizu login) or email feedback@orizu.ai
```

Do not retry in a loop. Sign in when a person can authorize it, or tell them to use the mailbox.
