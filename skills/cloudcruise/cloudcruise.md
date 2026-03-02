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
cloudcruise auth login --api-key "sk_..."   # Save credentials
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

# 3. Inspect -- examine BOTH the screenshot AND the HTML snapshot
#    Always look at both: the screenshot shows what the user sees,
#    the HTML snapshot shows the actual DOM for XPath debugging.
cloudcruise run snapshots <new_session_id> <node_id>
#    - Download the page_snapshot_url HTML and search for the failing selector's attributes
#    - View the screenshot (error_screenshot: true) to understand the visual page state

# 4. Fix -- edit the workflow file, then push the update
#    Edit workflow.json using file editing tools (targeted line replacements)
#    Always include a --version-note describing what changed
cloudcruise workflows update <workflow_id> --file workflow.json --version-note "Fixed XPath selector for submit button"

# 5. Verify -- confirm the fix works
cloudcruise run start <workflow_id> --input '{}' --wait
```

## Working with Debug Snapshots

Use the `node_id` from `run get` errors to target the right node:

```bash
# Error tells you which node failed -- use its node_id
cloudcruise run snapshots <session_id> <node_id>
```

The response contains:

- `page_snapshot_url` -- signed URL to an HTML snapshot of the page DOM at that node. Essential for diagnosing XPath/selector issues -- search for the attributes referenced in the failing selector.
- `screenshots` -- signed image URLs. Look for `error_screenshot: true` to find the screenshot taken at the moment of failure.

**Always examine both artifacts.** The screenshot tells you what the page looks like (is the element visible? is there a popup blocking it? is it a different page than expected?). The HTML snapshot tells you the actual DOM structure (does the element exist? do the attributes match the selector?).

If `page_snapshot_url` is null, the run was not executed with `--debug`. Re-run with `--debug` to capture snapshots (see Error-Fix-Verify Loop step 2).

**Fetching and reading the page snapshot:**

The `page_snapshot_url` is a signed URL -- you must download it to read the content. Page snapshots can be very large (thousands of lines of HTML). Save to a file and search targeted sections rather than reading the entire file.

```bash
curl -sL "<page_snapshot_url>" > snapshot.html

# Search for the failing selector to understand why it didn't match
# Example: if the error mentions an XPath with placeholder='Username'
grep -n "Username" snapshot.html
grep -n "placeholder" snapshot.html

# Read specific line ranges around matches to understand the DOM structure
```

Focus on searching for the element attributes referenced in the failing action's XPath or selector (aria-label, placeholder, id, type, etc.) to determine if the element exists, has different attributes, or is in a different location than expected.

## Key Details

- `run get` returns: status, output_data, workflow_errors (with node_id, llm_error_category, llm_error_description), screenshot_urls (with node_id)
- `run start --wait` prints NDJSON events to stdout, then the final run result. Exit code 0 = success, 1 = failure.
- `run errors --since` accepts duration strings: `24h`, `7d`, `30m`
- `workflows update` requires: nodes, edges, name, input_schema, output_schema, max_retries. Keep all other mutable fields from the GET response (e.g., description, enable_xpath_recovery, proxy_setting).
- Strip read-only fields before updating: id, version_id, version_number, created_at, created_by, workspace_id, loginStructure. The PUT endpoint rejects these.
- All commands accept `--api-key` and `--base-url` overrides
- Auth resolution: `--api-key` flag > `CLOUDCRUISE_API_KEY` env > `~/.cloudcruise/config.json`
