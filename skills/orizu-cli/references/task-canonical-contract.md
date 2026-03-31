# Task Canonical Contract

Use this reference when operating task workflows through the CLI.

## Canonical Task Fields

- `id`: stable task id
- `project_id`: owning project
- `dataset_id`: pinned dataset
- `app_id`: parent app
- `version_id`: pinned app-version id
- `title`: task name
- `description`: optional operator description
- `instructions`: optional reviewer instructions
- `required_assignments_per_row`: number of unique assignees requested per row
- `status`: `active`, `paused`, or `completed`

## Task Create Rules

- CLI task creation starts from `--app <appId>`, but the backend resolves and stores the app's pinned current `version_id` at create time.
- Task creation validates:
  - project/app coherence
  - project/dataset coherence
  - dataset compatibility against the pinned app version
  - object-store dataset materialization
  - assignee membership in the project team
- Malformed JSON or mixed-type assignee arrays fail with `400`.

## Assignment Fanout Rules

- Each assignee-row pair is unique per task.
- `--labels-per-item` cannot exceed the number of unique assignees supplied.
- If unique fanout cannot be fully satisfied, the backend shortfalls instead of duplicating a pair.

## Export And Downstream Rules

- Task export only includes completed assignments with saved responses.
- Exported rows use canonical `dataset_row_id` and row payload data.
- Downstream consumers should trust the task's pinned `version_id`, not the app's current pointer at read time.
