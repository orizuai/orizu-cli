# Assignment Canonical Contract

Status: canonical as of 2026-03-31.

## Worker ownership

- Worker assignment reads are self-only.
- Regular members must not see another assignee's queue or response payloads.
- Manager/admin/owner reporting remains valid for admin surfaces.

## Assignment lifecycle

- Canonical statuses: `pending`, `in_progress`, `completed`, `skipped`, `paused`.
- Assignees may only move assignments to:
  - `in_progress`
  - `completed`
  - `skipped`
- Assignees cannot set `paused` or `pending` directly.
- Assignment updates are rejected unless the parent task is `active`.

## Response contract

- Completing an assignment requires `response_data`.
- `response_data` must be a JSON object.
- Validation resolves against the task's pinned app-version `output_json_schema`, not the app's latest version.
- Supported validation surface: `type`, `required`, `properties`, `items`, `enum`.

## Operator notes

- `orizu tasks status` reports `paused` counts separately from `pending`.
- Interrater grouping should use `(task_id, dataset_row_id)`.
