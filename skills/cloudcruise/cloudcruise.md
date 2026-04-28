# CloudCruise CLI

Command-line tool for managing CloudCruise workflows and runs. All output is JSON to stdout; errors go to stderr.

## Setup

```bash
npm install -g @cloudcruise/cli
cloudcruise auth login --api-key "sk_..."
```

Or set `CLOUDCRUISE_API_KEY` environment variable.

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
cloudcruise auth login --api-key "sk_..." --encryption-key "hex..."  # Save credentials + vault key
cloudcruise auth login --api-key "sk_..."                            # Save credentials (no vault key)
cloudcruise auth login --encryption-key "hex..." --profile <name>    # Add vault key to existing profile
cloudcruise auth status                      # Check auth (masked key, source)
cloudcruise auth switch <profile>            # Set the active auth profile
cloudcruise auth profiles                    # List all auth profiles
cloudcruise auth logout                      # Remove saved credentials
```

### Workflows

Use `workflows` commands to edit existing workflows. For new workflows, use the builder instead.

```bash
cloudcruise workflows get <workflow_id>                                          # Get workflow definition with nodes
cloudcruise workflows update <workflow_id> --file w.json --version-note "..."   # Update workflow (creates new version)
cloudcruise workflows update <workflow_id> --stdin --version-note "..."          # Update from piped JSON
```

**When adding new nodes, always generate UUIDs with `cloudcruise utils uuid`.** Node IDs must be valid UUIDs -- do not use natural language IDs like `"click-submit-button"`.

**Edit pattern:** fetch → edit → push:

```bash
cloudcruise workflows get <workflow_id> > workflow.json
# Edit workflow.json with your file editing tools (targeted replacements, not full rewrites)
# Read-only fields (id, version_id, version_number, created_at, created_by,
# workspace_id, loginStructure, updated_at, workflow_id, encrypted_keys) are stripped automatically.
cloudcruise workflows update <workflow_id> --file workflow.json --version-note "Description of changes"
```

**Login workflow edit pattern:** For existing login workflows, make the first three nodes `START (logged-in destination URL)` → `IF (already logged in?)` → false branch login recovery. On the false branch, set `clear_cookies_on_false: true`, then add a `NAVIGATE` node to the login page before the credential-entry steps.

**Download capture pattern:** In manual workflow edits, add a `FILE_DOWNLOAD` node immediately after any `CLICK` that triggers a download. The builder adds this automatically; direct workflow edits do not.

**Iterative build pattern** (for creating workflows node-by-node without the builder):

```bash
# 1. Start with a minimal workflow: START (target URL) → END
#    Run with --debug to capture a snapshot of the landing page
cloudcruise run start <workflow_id> --input '{}' --wait --debug

# 2. Discover elements → validate → add nodes → run again → repeat
cloudcruise snapshot suggest <session_id> <end_node_id>
cloudcruise snapshot test "//input[@name='email']" <session_id> <end_node_id>
# Edit workflow.json, push with: cloudcruise workflows update ... --version-note "..."
cloudcruise run start <workflow_id> --input '{}' --wait --debug
# On success: inspect END node's snapshot for the next page state.
# On failure: inspect the failed node's snapshot (see Debug Snapshots).
```

### Utils

```bash
cloudcruise utils uuid              # Generate a random UUID (for new node IDs)
cloudcruise utils uuid --count 5    # Generate multiple UUIDs
```

### Runs

```bash
cloudcruise run start <workflow_id>                          # Start run, returns { session_id }
cloudcruise run start <workflow_id> --wait                   # Start and stream events until done
cloudcruise run start <workflow_id> --wait --debug           # Start with debug snapshots on every node
cloudcruise run start <workflow_id> --input '{"key":"val"}'  # Start with input variables
cloudcruise run get <session_id>                             # Get run status, errors, screenshots, output
cloudcruise run list --workflow <id> --status <s> --since 7d --limit 50 # List runs with filters
cloudcruise run interrupt <session_id>                       # Stop a running session
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
cloudcruise builder poll                                       # Check status + new messages
# poll returns: { status: "processing"|"done"|"error"|"waiting_for_input", text, tools, ... }

# ── Respond to human input requests ──
cloudcruise builder respond --message-id "msg-456" --value "123456"
cloudcruise builder respond --message-id "msg-456" --responses '{"email":"user@example.com","password":"s3cret"}'

# ── Inspect session state ──
cloudcruise builder status              # Check if session is active, get workflow summary
cloudcruise builder workflow            # Get current workflow definition (nodes, edges)
cloudcruise builder messages            # Get conversation history
cloudcruise builder messages --limit 5  # Last 5 messages only

# ── Session lifecycle ──
cloudcruise builder save        # Persist workflow to the database
cloudcruise builder interrupt   # Stop the agent's current processing
cloudcruise builder end         # End session and clean up
```

**Session is implicit** — `start` saves the conversation ID locally. All other builder commands use it automatically. One active session at a time.

**Important guidelines:**
- `builder send` returns immediately — use `builder poll` to check for completion
- Break complex tasks into small steps (e.g. "log in", then "navigate to X", then "search for Y")
- Poll in a loop — if poll returns `processing`, wait a few seconds and poll again
- **`waiting_for_input` is how the builder asks for information it needs** (e.g. email, password, 2FA code). When you see it, relay the question to the user, then pass their answer back with `builder respond`. The agent may request multiple inputs at once — check `waitingForInputs.inputs` for the full list and use `--responses` with a JSON object keyed by input name. Never pre-emptively browse the site or ask the user for form values — let the builder discover what it needs.
- Only fall back to direct DSL editing after the builder reaches a true terminal state such as `done` or `error`.
- **Wait for `done`/`error` before sending the next message** — sending while the agent is processing interrupts the current turn

**Writing effective builder messages:**

- **Describe the goal, not the clicks** — say "Download all EOBs from the claims table" not "Click the first download link in the third column". The builder sees the page and will figure out selectors, logic, and interaction details on its own.
- **Don't tell the builder how to build** — never specify execution types ("use STATIC"), selector strategies ("use an XPath with @id"), or node structure ("add a LOOP node"). The builder has access to the page DOM and knows the workflow DSL; let it make implementation decisions.
- **Reference credentials naturally** — "Log in using the vault credentials" is enough. The builder knows to use vault credential templates.

**Poll statuses:** `done` → proceed to next step. `waiting_for_input` → respond then poll. `error` → read text, send corrective instruction. `processing` → wait and poll again. `idle` → no pending work.

**Send + poll pattern:**

```bash
cloudcruise builder send "Log me in"
# → {"status":"sent","messageCountBefore":2}

# Poll until agent reaches a terminal state
cloudcruise builder poll
# → {"status":"processing","tools":[...],"newMessageCount":3,"totalMessageCount":8}

cloudcruise builder poll
# → {"status":"done","text":"I built the login flow...","tools":[...]}

# If agent needs input (single value):
# → {"status":"waiting_for_input","waitingForInput":{"messageId":"m1","description":"What's the 2FA code?"}}
cloudcruise builder respond --message-id m1 --value "123456"
cloudcruise builder poll

# If agent needs multiple inputs at once:
# → {"status":"waiting_for_input","waitingForInputs":{"messageId":"m1","inputs":[{"name":"npi",...},{"name":"last_name",...}]}}
cloudcruise builder respond --message-id m1 --responses '{"npi":"1234567890","last_name":"Ziegler"}'
cloudcruise builder poll

# If agent needs credentials (type: "auth"):
# → {"status":"waiting_for_input","waitingForInputs":{"messageId":"m1","inputs":[{"name":"Portal Credentials","type":"auth",...}]}}
# 1. Look up the vault entry to get the domain:
cloudcruise vault list
# 2. Respond with { permissioned_user_id, domain }:
cloudcruise builder respond --message-id m1 --responses '{"Portal Credentials":{"permissioned_user_id":"d2b9d80e-...","domain":"https://example.com"}}'
cloudcruise builder poll
```

**Full example: Login → Navigate → Search**

```bash
# Start
cloudcruise builder start --start-url "https://app.example.com" --name "Search workflow" \
  --vault-user-id "f47ac10b-58cc-4372-a567-0e02b2c3d479" --vault-domain "https://app.example.com"

# Step 1: Login
cloudcruise builder send "Log in using the vault credentials"
cloudcruise builder poll   # repeat until "done"

# Step 2: Navigate
cloudcruise builder send "Click on Reports in the nav bar, then select Monthly Summary"
cloudcruise builder poll   # repeat until "done"

# Step 3: Search and extract
cloudcruise builder send "Search for order 12345 and extract the status"
cloudcruise builder poll   # repeat until "done"

# Save and clean up
cloudcruise builder save
cloudcruise builder end
```

## Workflow DSL Reference

See `references/workflow-dsl.md` for the complete workflow DSL reference: all node types, parameters, edge structure, variable system, execution types, XPath best practices, data model schema extensions, and error classification.

## Error-Fix-Verify Loop

Pattern for diagnosing and fixing workflow failures:

```bash
# 1. Diagnose
cloudcruise run get <session_id>
cloudcruise workflows get <workflow_id> > workflow.json

# 2. Reproduce with snapshots (failed runs often lack them)
cloudcruise run start <workflow_id> --input '{}' --wait --debug

# 3. Inspect the failed node (see Debug Snapshots for timing details)
cloudcruise snapshot fetch <new_session_id> <failed_node_id>
cloudcruise snapshot suggest <new_session_id> <failed_node_id>
cloudcruise snapshot test "<new_xpath>" <new_session_id> <failed_node_id>

# 4. Fix and push
cloudcruise workflows update <workflow_id> --file workflow.json --version-note "Fixed XPath for submit button"

# 5. Verify
cloudcruise run start <workflow_id> --input '{}' --wait
```

## Debug Snapshots

After a `--debug` run, use `snapshot` commands to inspect pages and generate XPaths. Use the `node_id` from `run get` errors or from the `--wait` event stream.

```bash
cloudcruise snapshot fetch <session_id> <node_id>
cloudcruise snapshot suggest <session_id> <node_id>
cloudcruise snapshot test "//input[@name='email']" <session_id> <node_id>
```

**`snapshot suggest`** returns JSON with each element's tag, suggested XPath, uniqueness (`match_count === 1`), alternatives, meaningful attributes, and visible text. Prioritizes `@name`, `@id`, `@data-qa`/`@data-testid`, `@aria-label`, `@placeholder`, and visible text. Filters out generated IDs and non-semantic classes.

**`snapshot test`** confirms an XPath matches exactly one element (`unique: true`). Always test before pushing a workflow update.

**Also view the screenshot** (saved by `snapshot fetch`) to check visibility, popups, or unexpected pages.

If `snapshot fetch` reports no HTML, the run was not `--debug`. Re-run with `--debug`.

**Snapshot timing:** Snapshots capture page state *when a node starts executing* (i.e., post-action state of the *previous* node). To see what appeared after a node's action, inspect the *next* node's snapshot. On success, the END node shows final state. On failure, the END node has no snapshot — use the *failed* node's snapshot instead.

## Key Details

- `run get` returns: status, output_data, workflow_errors (with node_id, llm_error_category, llm_error_description), screenshot_urls (with node_id)
- `run start --wait` prints NDJSON events to stdout, then the final run result. Exit code 0 = success, 1 = failure.
- `run list --since` accepts duration strings: `24h`, `7d`, `30m`; without `--since`, the API defaults to the last 24 hours
- `run errors --since` accepts duration strings: `24h`, `7d`, `30m`
- `workflows update` requires: nodes, edges, name, input_schema, output_schema, max_retries. Keep all other mutable fields from the GET response (e.g., description, enable_xpath_recovery, proxy_setting).
- All commands accept `--api-key`, `--base-url`, and `--encryption-key` overrides
- Auth resolution: `--api-key` flag > `CLOUDCRUISE_API_KEY` env > `~/.cloudcruise/config.json`
- Encryption key resolution: `--encryption-key` flag > `CLOUDCRUISE_ENCRYPTION_KEY` env > profile config

## Working with Vault Credentials

The vault stores encrypted credentials to be used in workflows. Three fields are encrypted client-side: `user_name`, `password`, `tfa_secret`. The CLI handles encryption/decryption automatically.

**Encryption key setup** -- required for vault create, update, get --decrypt, encrypt, and decrypt:

```bash
cloudcruise auth login --api-key "sk_..." --encryption-key "hex..."
# Or set CLOUDCRUISE_ENCRYPTION_KEY environment variable
# Or pass --encryption-key on each command
```

The encryption key is a 64-character hex string (256-bit AES key) from [workspace settings](https://app.cloudcruise.com/settings/encryption-keys).

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

# 3. Run the workflow with the credential
cloudcruise run start <workflow_id> --input '{"USER": "f47ac10b-58cc-4372-a567-0e02b2c3d479"}' --wait
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
cloudcruise run start <workflow_id> --input '{"USER": "b91a8def-12c4-4a67-8e3f-5c6d7e8f9a0b"}' --wait
```
