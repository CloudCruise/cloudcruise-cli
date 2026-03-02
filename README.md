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

## Coding Agent Integration

Install skill files so your coding agent has the full CLI and workflow DSL reference:

```bash
cloudcruise install --skills                  # Claude Code + Cursor
cloudcruise install --skills --target claude   # Claude Code only
cloudcruise install --skills --target cursor   # Cursor only
```

## All Commands

| Command                        | Description                           |
| ------------------------------ | ------------------------------------- |
| `auth login`                   | Save API key                          |
| `auth status`                  | Check authentication                  |
| `auth logout`                  | Remove credentials                    |
| `workflows get <id>`           | Get workflow definition               |
| `workflows update <id>`        | Update workflow (new version)         |
| `run start <id>`               | Start a run                           |
| `run get <id>`                 | Get run status and results            |
| `run list`                     | List runs with filters                |
| `run interrupt <id>`           | Stop a running session                |
| `run errors <id>`              | Error analytics                       |
| `run snapshots <id> <node_id>` | Debug snapshots                       |
| `utils uuid`                   | Generate UUIDs for node IDs           |
| `install --skills`             | Install skill files for coding agents |

## License

MIT
