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
cloudcruise auth logout                      # Remove saved credentials
```

### Workflows

```bash
cloudcruise workflows get <workflow_id>                                          # Get workflow definition with nodes
cloudcruise workflows update <workflow_id> --file w.json --version-note "..."   # Update workflow (creates new version)
cloudcruise workflows update <workflow_id> --stdin --version-note "..."          # Update from piped JSON
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
cloudcruise run list --workflow <id> --status <s> --limit 50 # List runs with filters
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

## Workflow DSL Reference

See `references/workflow-dsl.md` for the complete workflow DSL reference: all node types, parameters, edge structure, variable system, execution types, XPath best practices, data model schema extensions, and error classification.

## Working with Workflow JSON

Always save workflow JSON to a file before editing. Workflow definitions can be large (dozens of nodes with XPath selectors, parameters, conditions). Working through files lets you read specific sections and make surgical edits without holding the entire JSON in context.

**When adding new nodes, always generate UUIDs with `cloudcruise utils uuid`.** Node IDs must be valid UUIDs -- do not use natural language IDs like `"click-submit-button"`.

```bash
# Fetch and save to file
cloudcruise workflows get <workflow_id> > workflow.json

# Edit the file using your file editing tools:
#   - Read specific line ranges to find the node you need
#   - Make targeted replacements (e.g. fix an XPath selector)
#   - Don't rewrite the entire file for a single-field change

# Push the updated workflow
# Strip read-only fields from the GET response: id, version_id, version_number,
# created_at, created_by, workspace_id, loginStructure
# Keep everything else (all mutable fields, both required and optional).
# Always include a version note describing the change.
cloudcruise workflows update <workflow_id> --file workflow.json --version-note "Description of changes"
```

## Error-Fix-Verify Loop

Pattern for diagnosing and fixing workflow failures:

```bash
# 1. Diagnose -- inspect the failed run and save the workflow to a file
cloudcruise run get <session_id>
cloudcruise workflows get <workflow_id> > workflow.json

# 2. Reproduce -- re-run with --debug for full snapshots
#    Failed runs often lack snapshots; --debug forces every node to capture one
cloudcruise run start <workflow_id> --input '{}' --wait --debug

# 3. Inspect -- download artifacts and auto-generate correct selectors
#    The failed node's snapshot shows the page state when it started executing
#    (i.e., the post-action state of the previous node -- this is what you want).
cloudcruise snapshot fetch <new_session_id> <failed_node_id>
#    View the screenshot to understand the visual page state
#    Auto-suggest XPaths for all interactive elements on the page
cloudcruise snapshot suggest <new_session_id> <failed_node_id>
#    Validate the new selector matches exactly 1 element before editing the workflow
cloudcruise snapshot test "<new_xpath>" <new_session_id> <failed_node_id>

# 4. Fix -- edit the workflow file, then push the update
#    Edit workflow.json using file editing tools (targeted line replacements)
#    Always include a --version-note describing what changed
cloudcruise workflows update <workflow_id> --file workflow.json --version-note "Fixed XPath selector for submit button"

# 5. Verify -- confirm the fix works
cloudcruise run start <workflow_id> --input '{}' --wait
```

## Working with Debug Snapshots

After a `--debug` run, use `snapshot` commands to inspect pages and generate XPaths. Use the `node_id` from `run get` errors or from the `--wait` event stream to target the right node.

```bash
# Download HTML snapshot + screenshots + metadata to a local directory
cloudcruise snapshot fetch <session_id> <node_id>
cloudcruise snapshot fetch <session_id> <node_id> --output-dir ./my-snapshots

# Auto-generate unique XPath selectors for every interactive element on the page
cloudcruise snapshot suggest <session_id> <node_id>

# Validate a specific XPath before adding it to the workflow
cloudcruise snapshot test "//input[@name='email']" <session_id> <node_id>
```

**`snapshot suggest`** returns JSON with each element's tag, suggested XPath, whether it's unique (`match_count === 1`), alternative XPaths, meaningful attributes, and visible text. Use this to pick selectors for STATIC execution nodes. The suggest engine prioritizes `@name`, `@id`, `@data-qa`/`@data-testid`, `@aria-label`, `@placeholder`, and visible text -- and filters out generated IDs and non-semantic classes automatically.

**`snapshot test`** confirms an XPath matches exactly one element (`unique: true`). Always test selectors before pushing a workflow update to avoid wasted runs.

**Also view the screenshot** (saved by `snapshot fetch` to the output directory) to understand the visual page state -- is the element visible? is there a popup blocking it? is it a different page than expected?

If `snapshot fetch` reports no HTML snapshot, the run was not executed with `--debug`. Re-run with `--debug` to capture snapshots (see Error-Fix-Verify Loop step 2).

**Snapshot timing:** Debug snapshots capture the page state *when a node starts executing*, which is the post-action state of the *previous* node. To discover elements that appeared after a node's action (e.g., a dropdown that rendered after clicking a menu button), inspect the *next* node's snapshot, not the current node's. On successful runs, the END node's snapshot shows the final page state after all preceding actions. On errored runs, the END node has no snapshot because execution never reached it -- use the *failed* node's snapshot instead (it captures the page state when the failure occurred).

## Building New Workflows

Iterative pattern for building a workflow from scratch:

```bash
# 1. Start with a minimal workflow: START (target URL) → END
#    Run with --debug to capture a snapshot of the landing page
cloudcruise run start <workflow_id> --input '{}' --wait --debug

# 2. Discover interactive elements on the landing page
#    Use the END node's snapshot -- it captures the page state AFTER all preceding nodes ran.
cloudcruise snapshot suggest <session_id> <end_node_id>

# 3. Pick selectors from the suggest output and validate them
cloudcruise snapshot test "//input[@name='email']" <session_id> <end_node_id>

# 4. Add the next node(s) to the workflow using the validated XPaths
#    Generate UUIDs: cloudcruise utils uuid
#    Edit workflow.json, push with: cloudcruise workflows update ... --version-note "..."

# 5. Run again with --debug to capture the next page state after the new nodes
cloudcruise run start <workflow_id> --input '{}' --wait --debug

# 6. Repeat: suggest → test → add nodes → run → suggest ...
#    On success: use the END node's snapshot to discover what's on the new page.
#    On failure: use the FAILED node's snapshot -- it has the page state when the
#    failure occurred (post-action state of the previous node). The END node has
#    no snapshot on errored runs because execution never reached it.
```

Each iteration adds one or a few nodes, then runs to capture the next page state. Use `snapshot suggest` on the last node's snapshot to discover what's available on the new page, then `snapshot test` to validate before committing.

## Key Details

- `run get` returns: status, output_data, workflow_errors (with node_id, llm_error_category, llm_error_description), screenshot_urls (with node_id)
- `run start --wait` prints NDJSON events to stdout, then the final run result. Exit code 0 = success, 1 = failure.
- `run errors --since` accepts duration strings: `24h`, `7d`, `30m`
- `workflows update` requires: nodes, edges, name, input_schema, output_schema, max_retries. Keep all other mutable fields from the GET response (e.g., description, enable_xpath_recovery, proxy_setting).
- Strip read-only fields before updating: id, version_id, version_number, created_at, created_by, workspace_id, loginStructure, updated_at, workflow_id. The PUT endpoint rejects these.
- All commands accept `--api-key`, `--base-url`, and `--encryption-key` overrides
- Auth resolution: `--api-key` flag > `CLOUDCRUISE_API_KEY` env > `~/.cloudcruise/config.json`
- Encryption key resolution: `--encryption-key` flag > `CLOUDCRUISE_ENCRYPTION_KEY` env > profile config

## Working with Vault Credentials

The vault stores encrypted credentials for browser automation workflows. Three fields are encrypted client-side: `user_name`, `password`, `tfa_secret`. The CLI handles encryption/decryption automatically.

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
  Use `vault encrypt` to prepare individual fields, then assemble the JSON.

**Pre-encrypted JSON payload example** (for `--file`/`--stdin`):

```bash
# Encrypt each field with `vault encrypt` (default mode, SDK-compatible)
ENC_USER=$(cloudcruise vault encrypt "user@example.com" | jq -r .ciphertext)
ENC_PASS=$(cloudcruise vault encrypt "s3cret" | jq -r .ciphertext)

# Assemble the JSON and pipe to vault create
echo '{"permissioned_user_id":"my-user","domain":"https://app.example.com","user_name":"'$ENC_USER'","password":"'$ENC_PASS'"}' \
  | cloudcruise vault create --stdin
```

**IMPORTANT:** Always use `vault encrypt` without `--raw` for pre-encrypted payloads. The `--raw` flag skips JSON serialization and produces ciphertext the vault API will reject (401). The default mode wraps values in JSON before encrypting, which is required for SDK compatibility.

**Important details:**

- The API field is `user_name` (not `username`). Use the `--user-name` flag.
- Vault entries are looked up by `--user-id` + `--domain`, not by UUID.
- `vault list` returns summary fields only: `id`, `permissioned_user_id`, `domain`, `user_alias`, `created_at`. Use `--full` for all fields.
- `vault get` returns encrypted fields by default. Add `--decrypt` for plaintext.
- The `--domain` must be a valid URL. `localhost` domains are rejected -- use `http://127.0.0.1:<port>` instead.
- The vault_schema `domain` and the vault entry `domain` must match exactly. The domain is for credential matching, not navigation.
- Session/persistence fields (`cookies`, `local_storage`, `persist_*`, concurrency settings, expiry) have no dedicated flags -- use `--file`/`--stdin` with full JSON.
- Secret flags (`--password`, `--user-name`, `--tfa-secret`) are visible in `ps` output. Use `--stdin` or `--file` for sensitive values.

## Credential Setup for Workflows

Pattern for creating vault credentials and wiring them into a workflow:

```bash
# 1. Create a credential
cloudcruise vault create \
  --user-id "my-app-user" \
  --domain "https://app.example.com" \
  --user-name "user@example.com" \
  --password "s3cret"

# 2. Wire the credential into the workflow's vault_schema and run_input_variables
#    vault_schema maps an alias to a domain:
#      { "USER": { "type": "credential", "domain": "app.example.com" } }
#    run_input_variables maps the alias to a permissioned_user_id:
#      { "USER": "my-app-user" }

# 3. Run the workflow with the credential
cloudcruise run start <workflow_id> --input '{"USER": "my-app-user"}' --wait
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

**IMPORTANT: `encrypted_keys` field.** When a workflow uses vault credentials in `input_variables`, the workflow must declare which input keys contain encrypted vault references in the `encrypted_keys` array. Without this, the runtime won't decrypt the credentials before injecting them into nodes.

```json
{
  "input_variables": { "USER": "my-app-user" },
  "encrypted_keys": ["USER"],
  "vault_schema": { "USER": { "type": "credential", "domain": "app.example.com" } }
}
```

**Switching credentials** is as simple as changing the `--input` value to a different `permissioned_user_id`:

```bash
cloudcruise run start <workflow_id> --input '{"USER": "other-user-id"}' --wait
```
