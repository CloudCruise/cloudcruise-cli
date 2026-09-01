# CloudCruise CLI

[![MIT License](https://img.shields.io/badge/License-MIT-red.svg?style=flat-square)](https://opensource.org/licenses/MIT)
![NPM Downloads](https://img.shields.io/npm/dw/@cloudcruise/cli)
[![GitHub Repo stars](https://img.shields.io/github/stars/CloudCruise/cloudcruise-cli?style=flat-square&logo=GitHub&label=cloudcruise-cli)](https://github.com/CloudCruise/cloudcruise-cli)
[![Discord](https://img.shields.io/discord/1227480834945318933?style=flat-square&logo=Discord&logoColor=white&label=Discord&color=%23434EE4)](https://discord.com/invite/MHjbUqedZF)
[![YC W24](https://img.shields.io/badge/Y%20Combinator-W24-orange?style=flat-square)](https://www.ycombinator.com/companies/cloudcruise)

CLI for managing [CloudCruise](https://cloudcruise.com) browser automation workflows and runs. Designed for coding agents to fix and edit CloudCruise workflows.
## Install

```bash
npm install -g @cloudcruise/cli
```

## Setup

Copy [.env.example](./.env.example) to `.env`, fill in the environment you want, then run `cloudcruise login`.


## Coding Agent Integration

**Claude Code** — install the plugin from this repo's marketplace:

```
/plugin marketplace add CloudCruise/cloudcruise-cli
/plugin install cloudcruise@cloudcruise
```

This registers all six skills (workflow build, test, debug, CLI and DSL reference) and keeps them updated with `/plugin update cloudcruise`.

**Other agents (Cursor, or Claude Code without plugins)** — install the skill files directly:

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

# Start a run (returns { session_id } immediately; poll run get for completion)
cloudcruise run start <workflow_id>

# Start a debug run with snapshots on every node
cloudcruise run start <workflow_id> --debug

# Run the workflow but skip final submit/save actions (validates writes without submitting)
cloudcruise run start <workflow_id> --dry-run

# Inspect a run (poll until the status is terminal)
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

| Command | Description |
| --- | --- |
| `login` | Browser OAuth + PKCE login |
| `logout` | Remove credentials for the active profile |
| `whoami` | Show the authenticated account |
| `auth login` | Browser OAuth + PKCE login |
| `auth status` | Check authentication (`--profile`) |
| `auth logout` | Remove credentials (`--profile`, `--all`) |
| `auth switch <name>` | Set the active profile |
| `auth profiles` | List all profiles |
| `auth workspace use <id>` | Set the active workspace for a profile |
| `workspaces list` | List workspaces for the active auth |
| `workspaces show` | Show the active workspace for a profile |
| `workspaces use <id>` | Set the active workspace for a profile |
| `workspaces clear` | Clear the active workspace for a profile |
| `workflows list` | List workflows (`--full` for details, `--folder <path>` to scope to a folder) |
| `workflows folders` | List workflow folders (`--path` to scope, `--search`) |
| `workflows get <id>` | Get workflow definition |
| `workflows versions <id>` | List workflow version history |
| `workflows update <id>` | Update workflow (`--file`, `--stdin`, `--version-note`) |
| `components list` | List workflow components (`--full`) |
| `components get <id>` | Get component (`--version-number`) |
| `components versions <id>` | List component versions (`--limit`) |
| `components usage <id>` | List workflows using this component |
| `components create` | Create component (`--name`, `--file`, `--stdin`) |
| `components rename <id>` | Rename a component (`--name`) |
| `components update <id>` | Update component (`--file`, `--stdin`, `--version-note`, `--no-propagate`, `--source-workflow-id`) |
| `components delete <id>` | Delete a component |
| `run start <id>` | Start a run, returns session_id immediately (`--debug`, `--input`) |
| `run get <id>` | Get run status and results (poll until terminal) |
| `run list` | List runs (`--workflow`, `--status`, `--limit`, `--since`) |
| `run interrupt <id>` | Stop a running session |
| `run respond <id>` | Submit user interaction data to a run waiting on a `USER_INTERACTION` node (`--data`, `--file`, `--stdin`) |
| `run live-view <id>` | Get a fresh live-view connection (viewer URL + one-time auth token) for an active session |
| `run errors <id>` | Error analytics (`--since`, `--limit`) |
| `run snapshots <id> <node_id>` | Get debug snapshot metadata |
| `snapshot fetch <sid> <nid>` | Download HTML, screenshots, metadata (`--html`, `--image`) |
| `snapshot suggest [sid] [nid]` | Suggest XPath selectors (`--file`, `--filter`) |
| `snapshot test <xpath> [sid] [nid]` | Test XPath against snapshot (`--file`, `--count`) |
| `vault list` | List vault entries (`--full`) |
| `vault get` | Get vault entry (`--user-id`, `--domain`, `--decrypt`) |
| `vault create` | Create vault entry (`--user-id`, `--domain`, `--user-name`, `--password`, `--secret-provider-id`, `--secret-ref`) |
| `vault update` | Update vault entry fields, including provider-backed bindings |
| `vault clear-state` | Clear browser state for a credential |
| `vault encrypt` / `decrypt` | Encrypt or decrypt values locally |
| `secret-providers list` | List secret-provider connections |
| `secret-providers items <provider-id>` | List items visible to a secret-provider connection |
| `builder start` | Start builder conversation (`--start-url`, `--name`, `--vault-user-id`) |
| `builder send <message>` | Send instruction to builder agent |
| `builder respond` | Reply to agent input requests (`--message-id`, `--value-stdin`) |
| `builder status` | Check conversation status (`/status` taxonomy + keepalive; exit code encodes the state — 0/7/8/9) |
| `builder conversations list` | List live builder conversations for the workspace |
| `builder conversations get [id]` | Get an archived conversation transcript, live or ended (`--limit` tails, `0` for metadata only; `--snapshot`, `--include-system`, `--output`) |
| `builder workflow` | Get current workflow definition |
| `builder messages` | Get conversation history (`--limit`, `--offset`, `--no-tail`) |
| `builder save` | Persist workflow to database (`-m/--message` sets the version note) |
| `builder interrupt` | Stop agent processing |
| `builder end` | End conversation and clean up |
| `utils uuid` | Generate UUIDs for node IDs (`--count`) |
| `install --skills` | Install skill files for coding agents (`--target`) |

The CLI uses a loopback redirect on `http://127.0.0.1` during login and stores reusable credentials in the OS keychain.
`run list` defaults to the last 24 hours when `--since` is omitted. Use values like `24h`, `7d`, or `30m` to adjust the time window.

## License

MIT
