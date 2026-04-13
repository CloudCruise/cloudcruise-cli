# CloudCruise CLI

CLI for managing [CloudCruise](https://cloudcruise.com) browser automation workflows and runs. Designed for coding agents to build, edit and fix CloudCruise workflows.

## Install

```bash
npm install -g @cloudcruise/cli
```

## Setup

```bash
cloudcruise auth login --api-key "sk_..."
cloudcruise auth login --api-key "sk_..." --encryption-key "hex..."  # With vault encryption key
```

Or set `CLOUDCRUISE_API_KEY` and optionally `CLOUDCRUISE_ENCRYPTION_KEY` environment variables.

## Coding Agent Integration

Install skill files so your coding agent has the full CLI and workflow DSL reference:

```bash
cloudcruise install --skills                  # Claude Code + Cursor
cloudcruise install --skills --target claude   # Claude Code only
cloudcruise install --skills --target cursor   # Cursor only
```

## Quick Start

```bash
# List all workflows in your workspace
cloudcruise workflows list

# Get a workflow
cloudcruise workflows get <workflow_id> > workflow.json

# Start a run and wait for completion
cloudcruise run start <workflow_id> --wait

# Start a debug run with snapshots on every node
cloudcruise run start <workflow_id> --wait --debug

# Start a run with input variables
cloudcruise run start <workflow_id> --input '{"key":"val"}' --wait

# Inspect a failed run
cloudcruise run get <session_id>

# Update a workflow
cloudcruise workflows update <workflow_id> --file workflow.json --version-note "Fixed login selector"
```

## Debugging with Snapshots

After a `--debug` run, use snapshot commands to diagnose failures:

```bash
# Download HTML snapshot, screenshots, and metadata for a node
cloudcruise snapshot fetch <session_id> <node_id>
cloudcruise snapshot fetch <session_id> <node_id> --html   # HTML only
cloudcruise snapshot fetch <session_id> <node_id> --image  # Screenshots only

# Suggest unique XPath selectors for interactive elements
cloudcruise snapshot suggest <session_id> <node_id>
cloudcruise snapshot suggest <session_id> <node_id> --filter input,button

# Test an XPath selector against a snapshot
cloudcruise snapshot test '//button[@id="submit"]' <session_id> <node_id>
cloudcruise snapshot test '//button[@id="submit"]' <session_id> <node_id> --count

# Work with a local HTML file instead of fetching from the API
cloudcruise snapshot suggest --file ./snapshots/page.html
cloudcruise snapshot test '//input[@name="email"]' --file ./snapshots/page.html
```

## Vault

Manage encrypted credentials for use in workflows. The CLI handles client-side AES-256-GCM encryption automatically.

```bash
cloudcruise vault list                                          # List all vault entries
cloudcruise vault get --user-id <id> --domain <domain>          # Get entry (encrypted)
cloudcruise vault get --user-id <id> --domain <domain> --decrypt  # Get entry (plaintext)
cloudcruise vault create --user-id <id> --domain <domain> \
  --user-name <name> --password <pass>                          # Create with auto-encrypt
cloudcruise vault update --user-id <id> --domain <domain> \
  --password <new_pass>                                         # Update specific fields
cloudcruise vault clear-state --user-id <id> --domain <domain>  # Clear browser state
cloudcruise vault encrypt "plaintext"                           # Encrypt a value locally
cloudcruise vault decrypt "ciphertext"                          # Decrypt a value locally
```

Requires an encryption key via `auth login --encryption-key`, `CLOUDCRUISE_ENCRYPTION_KEY` env, or `--encryption-key` flag.

## Builder

Build new workflows interactively through a conversational agent:

```bash
# Start a new workflow
cloudcruise builder start --start-url "https://app.example.com" --name "Login flow"
cloudcruise builder start --start-url "https://app.example.com" \
  --credential <user_id> --auth-url "https://app.example.com/login"

# Send instructions and poll for completion
cloudcruise builder send "Click the login button"
cloudcruise builder poll

# Respond to agent input requests
cloudcruise builder respond --message-id <id> --value "123456"
cloudcruise builder respond --message-id <id> --responses '{"email":"user@example.com"}'

# Inspect session
cloudcruise builder status       # Session status and workflow summary
cloudcruise builder workflow     # Current workflow definition
cloudcruise builder messages     # Conversation history

# Session lifecycle
cloudcruise builder save         # Persist workflow
cloudcruise builder interrupt    # Stop current processing
cloudcruise builder end          # End session and clean up
```

## All Commands

| Command | Description |
| --- | --- |
| `auth login` | Save API key and encryption key (`--profile`) |
| `auth status` | Check authentication (`--profile`) |
| `auth logout` | Remove credentials (`--profile`, `--all`) |
| `auth switch <name>` | Set the active profile |
| `auth profiles` | List all profiles |
| `workflows list` | List workflows (`--full` for details) |
| `workflows get <id>` | Get workflow definition |
| `workflows update <id>` | Update workflow (`--file`, `--stdin`, `--version-note`) |
| `run start <id>` | Start a run (`--wait`, `--debug`, `--input`) |
| `run get <id>` | Get run status and results |
| `run list` | List runs (`--workflow`, `--status`, `--limit`, `--since`) |
| `run interrupt <id>` | Stop a running session |
| `run errors <id>` | Error analytics (`--since`, `--limit`) |
| `run snapshots <id> <node_id>` | Get debug snapshot metadata |
| `snapshot fetch <sid> <nid>` | Download HTML, screenshots, metadata (`--html`, `--image`) |
| `snapshot suggest [sid] [nid]` | Suggest XPath selectors (`--file`, `--filter`) |
| `snapshot test <xpath> [sid] [nid]` | Test XPath against snapshot (`--file`, `--count`) |
| `vault list` | List vault entries (`--full`) |
| `vault get` | Get vault entry (`--user-id`, `--domain`, `--decrypt`) |
| `vault create` | Create vault entry (`--user-id`, `--domain`, `--user-name`, `--password`) |
| `vault update` | Update vault entry fields |
| `vault clear-state` | Clear browser state for a credential |
| `vault encrypt` / `decrypt` | Encrypt or decrypt values locally |
| `builder start` | Start builder session (`--start-url`, `--name`, `--credential`) |
| `builder send <message>` | Send instruction to builder agent |
| `builder poll` | Check agent status and new messages |
| `builder respond` | Reply to agent input requests (`--message-id`, `--value`) |
| `builder status` | Check session status |
| `builder workflow` | Get current workflow definition |
| `builder messages` | Get conversation history (`--limit`) |
| `builder save` | Persist workflow to database |
| `builder interrupt` | Stop agent processing |
| `builder end` | End session and clean up |
| `utils uuid` | Generate UUIDs for node IDs (`--count`) |
| `install --skills` | Install skill files for coding agents (`--target`) |

`run list` defaults to the last 24 hours when `--since` is omitted. Use values like `24h`, `7d`, or `30m` to adjust the time window.

## License

MIT
