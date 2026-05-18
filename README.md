# CloudCruise CLI

CLI for managing [CloudCruise](https://cloudcruise.com) browser automation workflows and runs. Designed for coding agents to fix and edit CloudCruise workflows.
## Install

```bash
npm install -g @cloudcruise/cli
```

## Setup

Copy [.env.example](./.env.example) to `.env`, fill in the environment you want, then source it before running `cloudcruise login`.


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

# Suggest unique XPath selectors for interactive elements
cloudcruise snapshot suggest <session_id> <node_id>

# Test an XPath selector against a snapshot
cloudcruise snapshot test '//button[@id="submit"]' <session_id> <node_id>

# Work with a local HTML file instead of fetching from the API
cloudcruise snapshot suggest --file ./snapshots/page.html
cloudcruise snapshot test '//input[@name="email"]' --file ./snapshots/page.html
```

## All Commands

| Command                                          | Description                                |
| ------------------------------------------------ | ------------------------------------------ |
| `login`                                          | Browser OAuth + PKCE login                 |
| `auth login`                                     | Browser OAuth + PKCE login                 |
| `auth status`                                    | Check authentication (`--profile <name>`)  |
| `auth logout`                                    | Remove credentials (`--profile`, `--all`)  |
| `auth switch <name>`                             | Set the active profile                     |
| `auth profiles`                                  | List all profiles                          |
| `auth workspace use <id>`                        | Set the active workspace for a profile     |
| `workspaces list`                                | List workspaces for the active auth        |
| `workflows list`                                 | List all workflows in your workspace       |
| `workflows get <id>`                             | Get workflow definition                    |
| `workflows versions <id>`                        | List workflow version history              |
| `workflows update <id>`                          | Update workflow (new version)              |
| `run start <id>`                                 | Start a run (`--wait`, `--debug`)          |
| `run get <id>`                                   | Get run status and results                 |
| `run list`                                       | List runs with filters                     |
| `run interrupt <id>`                             | Stop a running session                     |
| `run errors <id>`                                | Error analytics                            |
| `run snapshots <id> <node_id>`                   | Get debug snapshot metadata                |
| `snapshot fetch <session_id> <node_id>`          | Download HTML, screenshots, and metadata   |
| `snapshot suggest [session_id] [node_id]`        | Suggest unique XPath selectors             |
| `snapshot test <xpath> [session_id] [node_id]`   | Test an XPath selector against a snapshot  |
| `vault list`                                     | List vault entries                         |
| `vault get`                                      | Get vault entry                            |
| `vault create`                                   | Create vault entry with stdin secrets      |
| `vault update`                                   | Update vault entry fields                  |
| `vault clear-state`                              | Clear browser state for a credential       |
| `vault encrypt` / `vault decrypt`                | Encrypt or decrypt values locally          |
| `builder start`                                  | Start builder session                      |
| `builder send <message>`                         | Send instruction to builder agent          |
| `builder poll`                                   | Check agent status and new messages        |
| `builder respond`                                | Reply to input requests with stdin values  |
| `builder status`                                 | Check builder session status               |
| `builder workflow`                               | Get current workflow definition            |
| `builder messages`                               | Get conversation history                   |
| `builder save`                                   | Persist workflow to database               |
| `builder interrupt`                              | Stop agent processing                      |
| `builder end`                                    | End session and clean up                   |
| `utils uuid`                                     | Generate UUIDs for node IDs                |
| `install --skills`                               | Install skill files for coding agents      |

The CLI uses a loopback redirect on `http://127.0.0.1` during login and stores reusable credentials in the OS keychain.
`run list` defaults to the last 24 hours when `--since` is omitted. Use values like `24h`, `7d`, or `30m` to adjust the time window.

## License

MIT
