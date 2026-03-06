# CloudCruise CLI

CLI for managing [CloudCruise](https://cloudcruise.com) browser automation workflows and runs. Designed for coding agents to diagnose, fix, and verify workflow failures.

## Install

```bash
npm install -g @cloudcruise/cli
```

## Setup

```bash
cloudcruise auth login --api-key "sk_..."
```

## Coding Agent Integration

Install skill files so your coding agent has the full CLI and workflow DSL reference:

```bash
cloudcruise install --skills                  # Claude Code + Cursor
cloudcruise install --skills --target claude   # Claude Code only
cloudcruise install --skills --target cursor   # Cursor only
```

## Quick Start

```bash
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
| `auth login`                                     | Save API key                               |
| `auth status`                                    | Check authentication                       |
| `auth logout`                                    | Remove credentials                         |
| `workflows get <id>`                             | Get workflow definition                    |
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
| `utils uuid`                                     | Generate UUIDs for node IDs                |
| `install --skills`                               | Install skill files for coding agents      |

## License

MIT
