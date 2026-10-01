# Changelog

## Unreleased

### Changed

- `workflows update` detects stale edits. It sends the body's `version_id` as `base_version_id`; if someone saved in between, it creates no version and exits 12 (`WORKFLOW_VERSION_CONFLICT`). The stderr envelope adds `latestVersion` (id, number, author, time, note) and a `hint`. `--force` overwrites anyway. A body without `version_id` is not checked.
- `workflows update` sends the body as-is instead of stripping 11 fields. Edits to `encrypted_keys` now reach the backend. Requires a backend that accepts echoed read-only fields.
- `workflows update` no longer sends the body's `version_note`; the note comes only from `--version-note`. A fetched body's note describes the version it was fetched at.

## 1.13.0

### Added

- Exit 12 (`USAGE_LIMIT`) for HTTP 402 `USAGE_LIMIT_EXCEEDED`, when a run is refused because the workspace is out of browser hours. The stderr envelope adds the backend's `reason`, `currentUsage` and `limit`. The backend used to return this as 401 `UNAUTHENTICATED`, which exited 3 (`AUTH`) as if the credential were bad.

## 1.12.1

### Changed

- `cloudcruise-workflow-dsl` documents `run_if`: syntax, operators, the node types that support it, and how to gate DELAY, SCROLL and BOOL_CONDITION nodes inside a gated section.
- `cloudcruise-workflow-dsl` documents TRANSFORM. Every `SET` is required by default; `optional: true` allows an empty result, and there is no `required` field.
- `cloudcruise-workflow-dsl`: to wait after an action, raise the next node's `wait_time`. Use DELAY only when that element may already exist, isn't usable yet, or the next node has no selector.
- `cloudcruise-workflow-dsl` lists `end_here_on_dry_run` on INPUT_TEXT, INPUT_SELECT and EXTRACT_NETWORK, not only CLICK.
- `cc-workflow` references gate reveal-dependent nodes with `run_if` only on supported node types.
- DSL skill documents the `CAPTCHA` node and the `manual_captcha_solve` workflow field.
- New shared reference `captchas.md` for the build and test skills: which captchas the platform auto-solves, when to switch to manual solving, and the retry-loop pattern for text captchas.

## 1.12.0

### Added

- `error-codes list|get|create|update` manage workspace error codes. `create` is find-or-create by name and prints the code's `id`, which is what `error_on_false_message`, `error_message` and `selector_error_message` take. The backend rejects names, placeholders and free text in those params on `workflows update`. Fields come from flags or from one JSON object via `--file`/`--stdin`, not both. There are no `--retries`/`--retry-after` flags: the backend stores those values but nothing reads them, and the `retry` action only labels the error.

### Fixed

- `workflows update` strips `conversation_id` from the payload, so a `workflows get` → edit → `update` round trip no longer fails with "property conversation_id should not exist" on workflows last saved by the builder.

### Changed

- Every command that takes a JSON payload (`workflows update|import|validate-input`, `components create|update`, `vault create|update`, `run respond`, `error-codes create|update`) now reads it through one helper. Invalid JSON, a non-object payload, an unreadable `--file`, or passing more than one of `--data`/`--file`/`--stdin` now exit 2 (`BAD_ARGS`) with a message naming the flag; some of these used to exit 1. `vault create|update` with both `--file` and `--stdin` is now an error instead of silently using stdin.
- `vault create|update` reject field flags (`--domain`, `--password-stdin`, …) combined with `--file`/`--stdin` (exit 2). They used to send the JSON object and drop the flags without warning.
- DSL skill documents the error-code params as error code ids and adds an Error Codes section; the builder `respond` example uses a UUID instead of `ec_...`.
## 1.11.7

### Changed

- `cloudcruise-workflow-dsl` documents the newer `INPUT_TEXT` parameters: `omit_focus`, `paste_via_clipboard`, and `typing_delay_ms`, plus `{{...}}` keystroke tokens in `text` (`{{tab}}`, `{{enter}}`, `{{esc}}`, arrows, `{{ctrl_a}}`, …).

## 1.11.6

### Added

- `run start --no-notifications` suppresses workspace run notifications for that run (sends `notifications: { enabled: false }`; default stays enabled)

## 1.11.5

### Changed

- Improved skill file reference prose for `cc-workflow-setup`, `cc-workflow-build`, and `cc-workflow-test`

## 1.11.4

### Changed

- `cc-workflow-build` no longer auto-saves each branching component as a reusable CloudCruise component after proving it — component creation is a deliberate, separate action.
- `cc-workflow-build` dispatches linear-track plans as one whole-plan task instead of one message per step; the builder paces itself through the steps and checkpoints against real browser-state changes rather than the plan's line breaks.

## 1.11.3

- `builder conversations get [id]` reads a conversation's archived transcript

## 1.11.2

### Changed

- The `cc-workflow` recording reference now takes a Loom share URL directly: a worked `curl`/`jq` path fetches the metadata, the signed mp4 (short-lived URL, download immediately), and the official captions VTT, so a Loom link no longer needs a manual download first.
- The same reference lists its prerequisites up front (`ffmpeg`, `curl`, `jq`, and an ASR tool for narrated video without captions) and covers the no-transcript path: scene-change detection to find page transitions, extraction from frames alone, with missing intent surfaced in the confirm loop instead of guessed.

## 1.11.1

### Added

- `builder respond --value-stdin` accepts a structured JSON response, so error-code requests can be answered with their kind intact: `{"kind":"accept_suggestion"}`, `{"kind":"existing","error_code_id":"<id>"}`, or `{"kind":"remove_confirmed"}`. `builder status` surfaces the suggestion metadata on these requests.

### Changed

- `builder status` documents `terminal` as a settled turn, not an ended conversation: `awaiting-human-input` is terminal for polling, but the caller must respond before the builder proceeds.

## 1.11.0

### Added

- `cc-workflow` skill harness: takes a workflow through setup → build → test autonomously, driving the builder agent from local plan files.
- Installed skills warn when they drift from the CLI version that wrote them.
- `builder await-turn` blocks until the current builder turn settles and reports the outcome via exit code.
- `workflows validate-input` checks a run input payload against the workflow's saved input schema before running anything.

### Changed

- `install --skills` now supports Codex, Devin, Cursor, and other agents that read the shared `.agents/skills/` convention.
- `install --skills` overwrites previously installed skill files instead of merging into them, so a reinstall can't leave stale references behind.
- The packaged skill tells agents to run keychain-authenticated commands outside their sandbox, where macOS keychain access works.
- `run --dry-run` sends the object form the API now expects instead of a bare boolean.

## 1.10.1

### Fixed

- OAuth tokens are stored in the OS keychain as a raw secret (`setSecret`/`getSecret`) instead of a password string, so the Windows Credential Manager keeps the full JSON payload. Reads fall back to `getPassword()` so tokens written by earlier versions still load.
- `cc login` opens the browser correctly on Windows. The `cmd /c start` invocation now quotes the empty window title and the URL with `windowsVerbatimArguments`, so URLs containing `&` are no longer truncated by the shell.

## 1.10.0

### Added

- `workflows folders` lists workflow folders. Default output includes `allFolderPaths` (the complete folder tree) and the direct subfolders under the current path with a per-folder `workflow_count`. Supports `--path <path>` to scope to a subfolder, `--search <query>`, and `--full` for the raw API response.
- `workflows list --folder <path>` lists the workflows in a specific folder. It calls `GET /workflows/folders` and auto-paginates so every workflow in the folder is returned. Folders are the backend's path-based virtual folders (`workflows.folder_path` plus `workflow_virtual_folders` placeholders); `--folder` matches the path exactly (non-recursive).

## 1.9.0

### Added

- `run respond <session_id>` submits user interaction data to a run paused on a `USER_INTERACTION` node (`POST /run/{session_id}/user_interaction`). The key-value payload is provided via exactly one of `--data <json>`, `--file <path>`, or `--stdin`, and must be a JSON object matching the node's `expected_datamodel`.

## 1.8.5

### Added

- `builder save` accepts `-m/--message <string>` to set the version note for the save (max 2048 chars). Omitted or empty, the backend defaults the note to "Saved from API". Over-length messages are rejected client-side before the request.

## 1.8.3

### Added

- `run live-view <session_id>` fetches a fresh live-view connection (viewer URL + single-use auth token) for an active session. Re-run it to renew after a previously issued token has been consumed.

## 1.7.0

### Added

- `vault create` and `vault update` accept `--proxy <setting>` (`random`/`static`/`country`/`custom`) and `--proxy-value <value>`. For the Enterprise `custom` (bring-your-own) proxy, the URL is encrypted client-side with the workspace key before sending; for `static`/`country` the value (target IP / country code) is sent as plaintext.
- `--proxy-value-stdin` reads a custom proxy URL from stdin, keeping credentials out of shell history and process listings.

### Security

- `--proxy` is validated against the allowed enum before any request is sent.
- A custom `--proxy-value` is refused as a command-line argument (it may contain embedded credentials) and must be supplied via `--proxy-value-stdin`, matching the existing handling for `--password`/`--tfa-secret`.
- Setting `proxy_value` without `proxy_setting` is rejected, preventing a custom proxy URL from being sent in plaintext.
