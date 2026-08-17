---
name: cloudcruise
description: CloudCruise CLI reference for building, editing, and debugging CloudCruise workflows — builder agent sessions, workflow/component CRUD, vault credentials, runs, and debug snapshots. Use whenever a task involves the `cloudcruise` CLI or CloudCruise workflows.
---

# CloudCruise CLI

Command-line tool for managing CloudCruise workflows and runs. All output is JSON to stdout; errors go to stderr — consume stdout only, never merge with `2>&1` when parsing, and branch poll loops on exit codes rather than matching strings in the JSON.

## Setup

```bash
npm install -g @cloudcruise/cli
cloudcruise login
```

`cloudcruise login` is the primary authentication path. It uses browser OAuth, saves tokens to the OS keychain, and sets up the active workspace when possible. For CI or other non-interactive use, set `CLOUDCRUISE_TOKEN`; legacy API-key auth is still supported with `CLOUDCRUISE_API_KEY` for individual commands.

### Install Skills for Coding Agents

After installing the CLI, run this in your project root to expose the skill reference to your coding agent:

```bash
cloudcruise install --skills                  # Install for both Claude Code and Cursor
cloudcruise install --skills --target claude   # Claude Code only (.claude/skills/cloudcruise/)
cloudcruise install --skills --target cursor   # Cursor only (.cursor/rules/cloudcruise-cli.mdc)
```

## Commands

### Auth

```bash
cloudcruise login                            # Primary browser OAuth login
cloudcruise login --profile <name>           # Log in to a named auth profile
cloudcruise login --workspace-id <id>         # Save an active workspace on the profile
cloudcruise auth status                      # Check auth (masked key, source)
cloudcruise auth switch <profile>            # Set the active auth profile
cloudcruise auth profiles                    # List all auth profiles
cloudcruise auth logout                      # Remove saved credentials
```

For legacy API-key setup, avoid passing secrets as command-line arguments. Use stdin for a stored profile, or set `CLOUDCRUISE_API_KEY` for one-off command execution:

```bash
printf '%s' "$CLOUDCRUISE_API_KEY" | cloudcruise auth login --api-key-stdin
CLOUDCRUISE_API_KEY="sk_..." cloudcruise workflows list
```

### Workspaces

```bash
cloudcruise workspaces list                  # List workspaces available to the authenticated user
cloudcruise workspaces show                  # Show the active workspace for the auth profile
cloudcruise workspaces use <workspace_id>    # Set the active workspace for the auth profile
cloudcruise workspaces clear                 # Clear the active workspace for the auth profile
```

After OAuth login, the CLI auto-selects the only available workspace. If multiple workspaces are available in a non-interactive agent session, parse the login JSON for `workspace_selection_required: true` and `available_workspaces`, then run `cloudcruise workspaces use <workspace_id>` or pass `--workspace-id <workspace_id>` on later commands.

### Workflows

Use `workflows` commands to edit existing workflows. For new workflows, use the builder instead.

```bash
cloudcruise workflows list                                                       # List all workflows in the workspace
cloudcruise workflows list --folder "Claims/EOB"                                # List workflows inside a specific folder
cloudcruise workflows folders                                                    # List all folders (allFolderPaths = full tree)
cloudcruise workflows folders --path "Claims"                                   # List direct subfolders under a folder (with workflow counts)
cloudcruise workflows folders --search invoice                                  # Search folders/workflows by name or id
cloudcruise workflows get <workflow_id>                                          # Get latest workflow definition with nodes
cloudcruise workflows get <workflow_id> --version-number 18                      # Get a specific historical version
cloudcruise workflows versions <workflow_id>                                     # List version history (newest first)
cloudcruise workflows versions <workflow_id> --limit 10                          # Cap the list
cloudcruise workflows update <workflow_id> --file w.json --version-note "..."   # Update workflow (creates new version)
cloudcruise workflows update <workflow_id> --stdin --version-note "..."          # Update from piped JSON
```

**Workflow folders** are virtual: they are derived from each workflow's `folder_path` (a slash-separated string like `Claims/EOB`, max 5 levels) plus placeholder rows for empty folders. There is no folder ID. `workflows folders` returns `allFolderPaths` (the complete folder tree) and `folders` (direct subfolders under `--path`, with per-folder `workflow_count`). `workflows list --folder <path>` returns every workflow whose `folder_path` matches that path exactly (non-recursive).

**When adding new nodes, always generate UUIDs with `cloudcruise utils uuid`.** Node IDs must be valid UUIDs -- do not use natural language IDs like `"click-submit-button"`.

**Edit pattern:** fetch → edit → push:

```bash
cloudcruise workflows get <workflow_id> > workflow.json
# Edit workflow.json with your file editing tools (targeted replacements, not full rewrites)
# Read-only fields (id, version_id, version_number, created_at, created_by,
# workspace_id, loginStructure, updated_at, workflow_id, encrypted_keys) are stripped automatically.
cloudcruise workflows update <workflow_id> --file workflow.json --version-note "Description of changes"
```

**Rolling back versions:** `workflows versions` lists history newest first. Fetch a prior version's full JSON via `--version-number <N>` (same shape as latest), then push it back to roll back — history is preserved as a new version on top:

```bash
cloudcruise workflows get <workflow_id> --version-number 17 > rollback.json
cloudcruise workflows update <workflow_id> --file rollback.json --version-note "Rollback to v17"
```

**Login workflow edit pattern:** For existing login workflows, make the first three nodes `START (logged-in destination URL)` → `IF (already logged in?)` → false branch login recovery. On the false branch, set `clear_cookies_on_false: true`, then add a `NAVIGATE` node to the login page before the credential-entry steps.

**Download capture pattern:** In manual workflow edits, add a `FILE_DOWNLOAD` node immediately after any `CLICK` that triggers a download. The builder adds this automatically; direct workflow edits do not.

**Iterative build pattern** (for creating workflows node-by-node without the builder):

```bash
# 1. Start with a minimal workflow: START (target URL) → END
#    Run with --debug to capture a snapshot of the landing page
#    run start returns { session_id } immediately; poll run get until the status is terminal
cloudcruise run start <workflow_id> --input '{}' --debug
cloudcruise run get <session_id>

# 2. Discover elements → validate → add nodes → run again → repeat
cloudcruise snapshot suggest <session_id> <end_node_id>
cloudcruise snapshot test "//input[@name='email']" <session_id> <end_node_id>
# Edit workflow.json, push with: cloudcruise workflows update ... --version-note "..."
cloudcruise run start <workflow_id> --input '{}' --debug
cloudcruise run get <session_id>   # poll until terminal
# On success: inspect END node's snapshot for the next page state.
# On failure: inspect the failed node's snapshot (see Debug Snapshots).
```

### Workflow Components

Components are reusable sub-workflows. A component can be pasted into many workflows; an `update` to the component propagates to every workflow that uses it (`--no-propagate` to skip). Component-data shape mirrors a workflow body (nodes/edges).

```bash
cloudcruise components list                                                    # List components in your workspace
cloudcruise components get <component_id>                                      # Get latest version with componentData
cloudcruise components get <component_id> --version-number 3                   # Specific historical version
cloudcruise components versions <component_id>                                 # Version history (newest first)
cloudcruise components usage <component_id>                                    # Workflows that use this component
cloudcruise components create --name "Login flow" --file c.json                # Create from JSON
cat data.json | cloudcruise components create --name "Login flow" --stdin      # Create from stdin
cloudcruise components rename <component_id> --name "New name"                 # Rename only
cloudcruise components update <component_id> --file c.json --version-note "…"  # New version + propagate to instances
cloudcruise components update <component_id> --stdin --no-propagate            # Update without propagating
cloudcruise components delete <component_id>                                   # Delete the component
```

**Edit pattern:** same fetch → edit → push as workflows. Read-only fields (`id`, `component_id`, `version_id`, `version_number`, `version_note`, `created_at`, `created_by`, `updated_at`, `workspace_id`) are stripped from the update body. The CLI accepts either the full get-response (auto-unwraps `componentData`/`component_data`) or just the `componentData` payload.

```bash
cloudcruise components get <component_id> > component.json
# Edit component.json
cloudcruise components update <component_id> --file component.json --version-note "Fixed login XPath"
```

**Before updating, check what propagation will affect.** `update` defaults to `propagate=true` and will create a new version of every workflow that embeds the component. Inspect first, then decide:

```bash
cloudcruise components usage <component_id>                                   # List affected workflows
cloudcruise components update <component_id> --file c.json --version-note "…" # Default: propagate
cloudcruise components update <component_id> --file c.json --no-propagate     # Component-only update
```

### Utils

```bash
cloudcruise utils uuid              # Generate a random UUID (for new node IDs)
cloudcruise utils uuid --count 5    # Generate multiple UUIDs
```

### Runs

```bash
cloudcruise run start <workflow_id>                          # Start run, returns { session_id } immediately (non-blocking)
cloudcruise run start <workflow_id> --debug                  # Start with debug snapshots on every node
cloudcruise run start <workflow_id> --dry-run                # Run but skip final submit/save actions (nodes marked end_here_on_dry_run)
cloudcruise run start <workflow_id> --input '{"key":"val"}'  # Start with input variables
cloudcruise run get <session_id>                             # Get run status, errors, screenshots, output (poll until status is terminal)
cloudcruise run list --workflow <id> --status <s> --since 7d --limit 50 # List runs with filters
cloudcruise run interrupt <session_id>                       # Stop a running session
cloudcruise run respond <session_id> --data '{"approval_code":"123456"}' # Submit user interaction data to a run paused on a USER_INTERACTION node (--data/--file/--stdin)
cloudcruise run live-view <session_id>                       # Fresh viewer URL + one-time auth token to watch an active session (re-run to renew after the previous token is used)
cloudcruise run errors <workflow_id> --since 24h             # Error analytics (24h, 7d, 30m)
cloudcruise run snapshots <session_id> <node_id>             # Debug snapshots for a specific node
```

### Snapshots

Tools for downloading debug snapshots, auto-generating XPath selectors, and validating them against the page DOM. **Use these instead of manually downloading and searching HTML.**

```bash
cloudcruise snapshot fetch <session_id> <node_id>                  # Download HTML, screenshots, metadata to ./snapshots/
cloudcruise snapshot fetch <session_id> <node_id> --output-dir dir # Custom output directory
cloudcruise snapshot fetch <session_id> <node_id> --html           # Download only the HTML snapshot
cloudcruise snapshot fetch <session_id> <node_id> --image          # Download only the screenshot(s)
cloudcruise snapshot suggest <session_id> <node_id>                # Auto-suggest unique XPaths for all interactive elements
cloudcruise snapshot suggest --file page.html                      # Suggest from a local HTML file
cloudcruise snapshot suggest <sid> <nid> --filter input,button     # Only suggest for specific tags
cloudcruise snapshot test "<xpath>" <session_id> <node_id>         # Test an XPath against a snapshot (check uniqueness)
cloudcruise snapshot test "<xpath>" --file page.html               # Test against a local HTML file
cloudcruise snapshot test "<xpath>" <sid> <nid> --count            # Only return match count
```

### Vault

```bash
cloudcruise vault list                                              # List all vault entries (summary)
cloudcruise vault list --full                                       # List with all fields
cloudcruise vault get --user-id <id> --domain <domain>              # Get entry (encrypted fields)
cloudcruise vault get --user-id <id> --domain <domain> --decrypt    # Get entry (plaintext)
cloudcruise vault create --user-id <id> --domain <domain> \
  --user-name <name> --password <pass>                              # Create with auto-encrypt
cloudcruise vault update --user-id <id> --domain <domain> \
  --password <new_pass>                                             # Update specific fields
cloudcruise vault create --stdin < payload.json                     # Create from pre-encrypted JSON
cloudcruise vault clear-state --user-id <id> --domain <domain>       # Clear browser state (force fresh login)
cloudcruise vault encrypt "plaintext"                               # Encrypt a value (no API call)
cloudcruise vault decrypt "ciphertext"                              # Decrypt a value (no API call)
echo "secret" | cloudcruise vault encrypt --stdin                   # Encrypt from stdin
```

### Builder

Use the builder to create new workflows from scratch. For editing existing workflows, use `workflows get` + `workflows update` instead.

When the user asks to build a "workflow" / "cloudcruise workflow" / "cc workflow", **all web interaction goes through the builder** — do not browse the target site yourself with other tools. The builder agent handles all browsing; send it instructions and poll for results.

```bash
# ── Start a new workflow from scratch ──
cloudcruise builder start --start-url "https://app.example.com" --name "Login flow"
cloudcruise builder start --start-url "https://app.example.com" \
  --vault-user-id "f47ac10b-58cc-4372-a567-0e02b2c3d479" --vault-domain "https://app.example.com" \
  --proxy country --proxy-value US

# ── Interact with the builder agent ──
cloudcruise builder send "Click the login button"              # Returns immediately
cloudcruise builder status                                     # Check status (hits /status; also the keepalive)
# status returns: { status: "processing"|"awaiting-human-input"|"agent-errored"|"completed"|"idle"|"ended", terminal, isProcessing, workflowId?, ... }
# and its exit code encodes that status so a driver can switch on $?:
#   0 proceed (completed/idle/ended) · 7 answer (awaiting-human-input) · 8 intervene (agent-errored) · 9 tick+re-arm (processing)

# ── Respond to human input requests ──
printf '%s' "123456" | cloudcruise builder respond --message-id "msg-456" --value-stdin
printf '%s' '{"email":"user@example.com","password":"s3cret"}' | cloudcruise builder respond --message-id "msg-456" --responses-stdin

# ── Inspect conversation state ──
cloudcruise builder conversations list     # List live builder conversations for the workspace (newest first)
cloudcruise builder workflow               # Get current workflow definition (nodes, edges)
cloudcruise builder messages               # Get conversation history (pagination envelope)
cloudcruise builder messages --limit 5     # Last 5 messages only
cloudcruise builder messages --limit 20 --offset 20            # Page backward from the end
cloudcruise builder messages --limit 20 --offset 0 --no-tail   # Page forward from the start

# ── Target a specific conversation (concurrent/multi-conversation) ──
cloudcruise builder status --conversation "conv-abc123"
CLOUDCRUISE_CONVERSATION="conv-abc123" cloudcruise builder send "Click login"

# ── Conversation lifecycle ──
cloudcruise builder save        # Persist workflow to the database
cloudcruise builder interrupt   # Stop the agent's current processing
cloudcruise builder end         # End the conversation and clean up
```

**Credentials for builder sessions.** A workflow with a non-empty `vault_schema` needs its credential supplied, or login fails at the password step. Both `builder start` and `builder edit` take `--vault-user-id <permissioned_user_id>` + `--vault-domain <domain>` (both-or-neither) for a single credential; edit matches the domain to the workflow's `vault_schema` alias. For a multi-credential workflow, bind extra aliases via `builder edit --input '{"<alias>":"<permissioned_user_id>"}'`. `builder edit` also takes `--use-example-inputs` to pre-fill non-credential inputs from the workflow's `input_schema` examples (server-side).

**Conversation resolution is server-driven** — there is no local session file. `start` prints the `conversationId`; the server roster (`builder conversations list`) is the source of truth for what's live. When exactly one conversation is live in your workspace, every other builder command resolves to it automatically. When more than one is live, commands error with exit 5 (ambiguous) and you must pass `--conversation <id>` (or set `CLOUDCRUISE_CONVERSATION`). With none live, they exit 2. `--conversation` overrides everything, including workspace scope. Each command echoes `conversation <id> (via flag|env|roster)` to stderr so you can tell how it resolved.

**Important guidelines:**

- `builder send` returns immediately — use `builder status` to check for completion
- Break complex tasks into small steps (e.g. "log in", then "navigate to X", then "search for Y")
- Poll `builder status` in a loop — if it returns `processing`, wait a few seconds and call it again. `status` also keeps the session alive (it hits `/status`), so keep polling rather than letting an idle session get reaped.
- **`awaiting-human-input` is how the builder asks for information it needs** (e.g. email, password, 2FA code). When you see it, relay the question to the user, then pass their answer back with `builder respond`. The agent may request multiple inputs at once — check `humanInput.fields` for the full list and pipe a JSON object keyed by field name to `--responses-stdin`. Never pre-emptively browse the site or ask the user for form values — let the builder discover what it needs.
- Only fall back to direct DSL editing after the builder reaches a terminal state (`terminal: true` — i.e. `completed`, `agent-errored`, or `ended`).
- **Wait for a terminal status before sending the next message** — sending while the agent is processing interrupts the current turn, and a busy send returns HTTP 409 `SESSION_BUSY` (exit code 6)

**Writing effective builder messages:**

- **Describe the goal, not the clicks** — say "Download all EOBs from the claims table" not "Click the first download link in the third column". The builder sees the page and will figure out selectors, logic, and interaction details on its own.
- **Don't tell the builder how to build** — never specify execution types ("use STATIC"), selector strategies ("use an XPath with @id"), or node structure ("add a LOOP node"). The builder has access to the page DOM and knows the workflow DSL; let it make implementation decisions.
- **Reference credentials naturally** — "Log in using the vault credentials" is enough. The builder knows to use vault credential templates.

**Status codes** (`builder status` — exit code in parens): `completed` (0) → proceed to next step. `awaiting-human-input` (7) → respond then re-check. `agent-errored` (8) → inspect messages, send corrective instruction. `processing` (9) → wait and re-check. `idle` (0) → no pending work. `ended` (0) → session is over. `terminal: true` marks the states that won't change without a new turn (`completed`, `agent-errored`, `ended`). A driver can branch on the exit code alone without parsing stdout — note that a non-zero `status` exit (7/8/9) is the *state*, not a command failure.

**409 exit codes:** `builder send` on a busy session → `SESSION_BUSY` (exit 6). `builder respond` after the input was already answered → `ALREADY_ANSWERED` (exit 7). The code is printed to stderr.

`builder screenshot`/`html` with no attached browser → `NO_BROWSER_ATTACHED` (exit 10); provision/warm a browser, then retry.

**Send + status-poll pattern:**

```bash
cloudcruise builder send "Log me in"
# → {"conversationId":"conv-abc123","accepted":true}

# Poll until agent reaches a terminal state (terminal: true)
cloudcruise builder status
# → {"status":"processing","terminal":false,"isProcessing":true}

cloudcruise builder status
# → {"status":"completed","terminal":true,"isProcessing":false,"workflowId":"wf_..."}

# If agent needs input (single value):
# → {"status":"awaiting-human-input","terminal":false,"conversationId":"conv-abc123","humanInput":{"messageId":"m1","prompt":"What's the 2FA code?","fields":[{"name":"code","type":"text"}]}}
printf '%s' "123456" | cloudcruise builder respond --message-id m1 --value-stdin
cloudcruise builder status

# If agent needs multiple inputs at once:
# → {"status":"awaiting-human-input","terminal":false,"humanInput":{"messageId":"m1","prompt":"...","fields":[{"name":"npi",...},{"name":"last_name",...}]}}
printf '%s' '{"npi":"1234567890","last_name":"Ziegler"}' | cloudcruise builder respond --message-id m1 --responses-stdin
cloudcruise builder status

# If agent needs credentials (type: "auth"):
# → {"status":"awaiting-human-input","terminal":false,"humanInput":{"messageId":"m1","prompt":"...","fields":[{"name":"Portal Credentials","type":"auth",...}]}}
# 1. Look up the vault entry to get the domain:
cloudcruise vault list
# 2. Respond with { permissioned_user_id, domain }:
printf '%s' '{"Portal Credentials":{"permissioned_user_id":"d2b9d80e-...","domain":"https://example.com"}}' | cloudcruise builder respond --message-id m1 --responses-stdin
cloudcruise builder status
```

**Driving one turn from a script.** Branch on the `status` exit code; don't parse
stdout to decide whether a turn is over. Pass the message via `"$(cat file)"` —
composing a long message inline invites the shell to eat it (backticks inside a
double-quoted argument get command-substituted, truncating the message silently).

```bash
CID=conv-abc123
cloudcruise builder send --conversation "$CID" "$(cat task.txt)"   # returns immediately
while :; do
  cloudcruise builder status --conversation "$CID" >/dev/null 2>&1; rc=$?
  case $rc in
    0) break ;;                      # completed / idle / ended — turn is over
    9) sleep 15 ;;                   # processing — re-check (this also keeps the session alive)
    7) echo "needs input";  break ;; # awaiting-human-input — relay, then `builder respond`
    8) echo "agent errored"; break ;;# inspect `builder messages`, send a correction
    *) echo "status exit $rc"; break ;;
  esac
done
```

**Reading the agent's report.** `builder messages` records carry
`{ role, type, status, text }`. The report you want is the **last record with
`role: "assistant"` and non-empty `text`**; `role: "tool"` rows have no `text`, and
`type: "reasoning"` rows are the agent thinking rather than reporting. Use `--limit`
rather than pulling the whole history — a long build accumulates hundreds of records.

**Opening the builder UI.** `builder open` opens the current conversation. The app
URL is inferred from the API base URL and can be overridden with `--app-url`
(`--app-url http://localhost:3000` against a local API). The page is
`<app-url>/workflows/builder/<conversationId>`.

**Full example: Login → Navigate → Search**

```bash
# Start
cloudcruise builder start --start-url "https://app.example.com" --name "Search workflow" \
  --vault-user-id "f47ac10b-58cc-4372-a567-0e02b2c3d479" --vault-domain "https://app.example.com"

# Step 1: Login
cloudcruise builder send "Log in using the vault credentials"
cloudcruise builder status   # repeat until "completed"

# Step 2: Navigate
cloudcruise builder send "Click on Reports in the nav bar, then select Monthly Summary"
cloudcruise builder status   # repeat until "completed"

# Step 3: Search and extract
cloudcruise builder send "Search for order 12345 and extract the status"
cloudcruise builder status   # repeat until "completed"

# Save and clean up
cloudcruise builder save
cloudcruise builder end
```

## Workflow DSL Reference

See the **cloudcruise-workflow-dsl** skill for the complete workflow DSL reference: all node types, parameters, edge structure, variable system, execution types, XPath best practices, data model schema extensions, and error classification. Read it before writing, editing, or debugging any workflow node.

## Error-Fix-Verify Loop

Pattern for diagnosing and fixing workflow failures:

```bash
# 1. Diagnose
cloudcruise run get <session_id>
cloudcruise workflows get <workflow_id> > workflow.json

# 2. Reproduce with snapshots (failed runs often lack them)
#    run start returns { session_id } immediately; poll run get until the status is terminal
cloudcruise run start <workflow_id> --input '{}' --debug
cloudcruise run get <new_session_id>

# 3. Inspect the failed node (see Debug Snapshots for timing details)
cloudcruise snapshot fetch <new_session_id> <failed_node_id>
cloudcruise snapshot suggest <new_session_id> <failed_node_id>
cloudcruise snapshot test "<new_xpath>" <new_session_id> <failed_node_id>

# 4. Fix and push
cloudcruise workflows update <workflow_id> --file workflow.json --version-note "Fixed XPath for submit button"

# 5. Verify (run start returns { session_id }; poll run get until terminal)
cloudcruise run start <workflow_id> --input '{}'
cloudcruise run get <new_session_id>
```

## Debug Snapshots

After a `--debug` run, use `snapshot` commands to inspect pages and generate XPaths. Use the `node_id` from `run get` errors or from the `run get` node results.

```bash
cloudcruise snapshot fetch <session_id> <node_id>
cloudcruise snapshot suggest <session_id> <node_id>
cloudcruise snapshot test "//input[@name='email']" <session_id> <node_id>
```

**`snapshot suggest`** returns JSON with each element's tag, suggested XPath, uniqueness (`match_count === 1`), alternatives, meaningful attributes, and visible text. Prioritizes `@name`, `@id`, `@data-qa`/`@data-testid`, `@aria-label`, `@placeholder`, and visible text. Filters out generated IDs and non-semantic classes.

**`snapshot test`** confirms an XPath matches exactly one element (`unique: true`). Always test before pushing a workflow update.

**Also view the screenshot** (saved by `snapshot fetch`) to check visibility, popups, or unexpected pages.

If `snapshot fetch` reports no HTML, the run was not `--debug`. Re-run with `--debug`.

**Snapshot timing:** Snapshots capture page state _when a node starts executing_ (i.e., post-action state of the _previous_ node). To see what appeared after a node's action, inspect the _next_ node's snapshot. On success, the END node shows final state. On failure, the END node has no snapshot — use the _failed_ node's snapshot instead.

## Key Details

- `run get` returns: status, output_data, workflow_errors (with node_id, llm_error_category, llm_error_description), screenshot_urls (with node_id)
- `run start` returns `{ session_id }` immediately and does not block or stream. Poll `run get <session_id>` until the status is terminal to determine success or failure.
- `run list --since` accepts duration strings: `24h`, `7d`, `30m`; without `--since`, the API defaults to the last 24 hours
- `run errors --since` accepts duration strings: `24h`, `7d`, `30m`
- `workflows update` requires: nodes, edges, name, input_schema, output_schema, max_retries. Keep all other mutable fields from the GET response (e.g., description, enable_xpath_recovery, proxy_setting).
- All commands accept `--api-key`, `--base-url`, and `--encryption-key` overrides
- Auth resolution: `--api-key` flag > `CLOUDCRUISE_API_KEY` env > `~/.cloudcruise/config.json`
- Encryption key resolution: `--encryption-key` flag > `CLOUDCRUISE_ENCRYPTION_KEY` env > profile config

## Working with Vault Credentials

The vault stores encrypted credentials to be used in workflows. Three fields are encrypted client-side: `user_name`, `password`, `tfa_secret`. The CLI handles encryption/decryption automatically.

**Encryption key setup** -- required for vault create, update, get --decrypt, encrypt, and decrypt. `cloudcruise login` does NOT fetch the key automatically (it is a client-side key the server never hands out); you must supply it yourself:

```bash
# Recommended: store on a profile via stdin (kept in the OS keychain)
printf '%s' "<64-hex-key>" | cloudcruise login --encryption-key-stdin

# Or set it per-session via environment variable
export CLOUDCRUISE_ENCRYPTION_KEY="<64-hex-key>"
```

The encryption key is a 64-character hex string (256-bit AES key) from [workspace settings](https://app.cloudcruise.com/settings/encryption-keys).

Raw `--encryption-key <hex>` and `--api-key <key>` flags are **rejected by default** to keep secrets out of shell history and `ps` output. Use `--encryption-key-stdin` (or the env var) instead; set `CLOUDCRUISE_ALLOW_ARG_SECRETS=true` only for local testing.

**Two paths for create/update:**

- **Flag-driven** (plaintext flags, CLI encrypts automatically):
  `vault create --user-id X --domain Y --user-name "user" --password "pass"`
- **JSON payload** (`--file`/`--stdin`, assumed pre-encrypted):
  Use `vault encrypt` to prepare individual fields, then assemble the JSON and pipe to `vault create --stdin`.

**IMPORTANT:** Always use `vault encrypt` without `--raw` for pre-encrypted payloads. The `--raw` flag skips JSON serialization and produces ciphertext the vault API will reject (401).

**Important details:**

- The API field is `user_name` (not `username`). Use the `--user-name` flag.
- Vault entries are looked up by `--user-id` + `--domain`, not by UUID.
- `vault list` returns summary fields only. Use `--full` for all fields.
- `vault get` returns encrypted fields by default. Add `--decrypt` for plaintext.
- The `--domain` must be a valid URL. `localhost` domains are rejected -- use `http://127.0.0.1:<port>` instead.
- The vault_schema `domain` and the vault entry `domain` must match exactly.
- Session/persistence fields (`cookies`, `local_storage`, `persist_*`, concurrency, expiry) have no dedicated flags -- use `--file`/`--stdin` with full JSON.
- Secret flags (`--password`, `--user-name`, `--tfa-secret`) are visible in `ps` output. Use `--stdin` or `--file` for sensitive values.

## Credential Setup for Workflows

Pattern for creating vault credentials and wiring them into a workflow:

```bash
# 1. Create a credential
cloudcruise vault create \
  --user-id "f47ac10b-58cc-4372-a567-0e02b2c3d479" \
  --domain "https://app.example.com" \
  --user-name "user@example.com" \
  --password "s3cret"

# 2. Wire the credential into the workflow's vault_schema and run_input_variables
#    vault_schema maps an alias to a domain:
#      { "USER": { "type": "credential", "domain": "app.example.com" } }
#    run_input_variables maps the alias to a permissioned_user_id:
#      { "USER": "f47ac10b-58cc-4372-a567-0e02b2c3d479" }

# 3. Run the workflow with the credential (returns { session_id }; poll run get for completion)
cloudcruise run start <workflow_id> --input '{"USER": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}'
```

**Workflow node template syntax for vault credentials:**

Nodes reference vault credentials via `{{context.inputs.ALIAS.FIELD}}` where `ALIAS` is the vault_schema key and `FIELD` is `USER_NAME`, `PASSWORD`, or `TFA_SECRET` (uppercase).

Example INPUT_TEXT node using vault credentials:

```json
{
  "id": "<uuid>",
  "name": "Enter username",
  "action": "INPUT_TEXT",
  "parameters": {
    "selector": "//input[@name='email']",
    "text": "{{context.inputs.USER.USER_NAME}}",
    "execution": "STATIC"
  }
}
```

**Switching credentials** is as simple as changing the `--input` value to a different `permissioned_user_id`:

```bash
cloudcruise run start <workflow_id> --input '{"USER": "b91a8def-12c4-4a67-8e3f-5c6d7e8f9a0b"}'
```
