# Changelog

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
