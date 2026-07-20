---
name: promote-workflow
description: Copy a workflow definition from one CloudCruise environment to another (staging -> production) using two CLI profiles. Exports the source workflow's nodes/edges/schemas with `workflows get --profile <src>` and applies them onto an already-existing target workflow with `workflows update <target-id> --profile <dst>`. Handles the cross-environment gaps the raw copy does NOT carry: the target workflow must be seeded first (no `workflows create`), and vault credentials, node-embedded error-code IDs, referenced components, and the resource-group assignment do not transfer and must be reconciled in the target environment. Use when someone wants to promote/port/copy a workflow between environments (staging<->prod, or any two deployments). NOT for copying within one environment across workspaces — that's a same-DB fork, done in the dashboard.
user-invocable: true
allowed-tools: Bash, Read, Write, Grep, Glob
---

# promote-workflow — port a workflow between environments

Move a workflow's definition from a **source** environment (usually `staging`) to a
**target** environment (usually `production`). Staging and production are **separate
Supabase projects**, so nothing copies at the database layer — the bridge is two
authenticated CLI **profiles** and a `get | update` round-trip.

All base CLI syntax (`login`, `auth`, `workflows get/update`, `vault`, `components`,
`run`) lives in **`/cloudcruise`** — read it first if you don't have the command
surface loaded. This skill is the *method* layered on top: which fields survive the
hop, which don't, and how to reconcile the ones that don't.

> **What this is not.** Copying a workflow to another **workspace inside the same
> environment** is a single-database fork (`forkWorkflow` / "Copy" in the dashboard).
> That path remaps error-code IDs for you and stays in one DB. This skill is only for
> crossing **environments** (different Supabase projects), where no such helper exists.

---

## The model: one profile per environment

A CLI **profile** persists its own `baseUrl`, OAuth issuer, credentials (in the OS
keychain), and active workspace. `--profile <name>` on any command selects the
environment. So the whole job is: **read with the source profile, write with the
target profile.**

- **Production** is bundled — `cloudcruise login` (or `--profile prod`) works out of
  the box against `https://api.cloudcruise.com`.
- **Staging / any non-prod deployment** is *not* bundled in the open-source CLI. You
  must configure its issuer/client-id/base-url explicitly (team-internal values), via
  flags or a staging `.env`:

  ```bash
  # one-time: create a "staging" profile (fill in the team's staging values)
  cloudcruise login --profile staging \
    --issuer   "https://<staging-project>.supabase.co/auth/v1" \
    --client-id "<staging-oauth-client-id>" \
    --base-url  "https://staging-api.cloudcruise.com" \
    --anon-key  "<staging-supabase-anon-key>"

  # prod profile (bundled defaults; just pick the workspace)
  cloudcruise login --profile prod
  ```

Verify both, and that each points at the workspace you intend:

```bash
cloudcruise auth profiles                       # lists profiles, envs, workspaces
cloudcruise auth status --profile staging
cloudcruise auth status --profile prod
cloudcruise workspaces use <staging_ws> --profile staging   # if not already set
cloudcruise workspaces use <prod_ws>    --profile prod
```

---

## What survives the hop (and what doesn't)

`workflows update` sends the JSON body to `PUT /workflows/:id` and **auto-strips** a set
of read-only fields before writing — so you do **not** hand-clean them:

> stripped by `update`: `id`, `version_id`, `version_number`, `created_at`,
> `created_by`, `updated_at`, `workspace_id`, `workflow_id`, `loginStructure`,
> `encrypted_keys`.

That means the two fields most likely to poison a cross-env copy — `workspace_id` and
`created_by` (source-environment UUIDs) — are dropped automatically. Good.

| Travels cleanly | Does NOT travel — reconcile in target |
|---|---|
| `nodes`, `edges` | **Vault credentials** — secrets live in a separate per-org table, AES-encrypted under a **workspace-scoped key**; ciphertext is unusable in the target. Recreate with `vault create --profile <dst>`. |
| `input_schema` / `output_schema` | **Node-embedded error-code IDs** (`selector_error_message`, `error_on_false_message`, `error_message`) — these are per-workspace FKs. The CLI does **not** remap them (only the same-DB dashboard fork does). They'll dangle unless the same error codes exist in the target. |
| `vault_schema` (aliases/structure) | **`encrypted_keys`** — stripped by `update`. The target keeps its own; a fresh target shell has none, so the "encrypt these fields" designation must be set up on the target (see below). |
| workflow-level feature flags, `name`, `description`, proxy settings | **Referenced components** — if any node pulls in a workflow component, that component must exist in the target env (`components list/get/create --profile <dst>`). |
| | **Resource-group assignment** — environment-specific infra; set it in the target dashboard. |

---

## Procedure

### 1. Export from source

```bash
cloudcruise workflows get <source_workflow_id> --profile staging > wf.json
```

Inspect `wf.json` before writing: note whether it references components, whether any
node carries error-code IDs, and what `vault_schema` aliases it expects.

### 2. Seed the target workflow (one-time per workflow)

There is **no `workflows create`** in the CLI — `update` is a PUT to an *existing* id.
So the target workflow must already exist. Create an empty/new workflow in the
**target dashboard** (in the intended prod workspace) and copy its new workflow id.
This is the one unavoidable manual step; you only do it once per workflow — reruns
reuse the same target id.

> If you're promoting the *same* workflow repeatedly (a real staging->prod pipeline),
> record the `staging_id -> prod_id` mapping somewhere durable so step 3 is a
> one-liner each time.

### 3. Apply onto the target

```bash
cloudcruise workflows update <target_workflow_id> --file wf.json \
  --profile prod \
  --version-note "Promoted from staging <source_workflow_id> @ $(git rev-parse --short HEAD 2>/dev/null || date +%F)"
```

Every update mints a new version in the target. `workspace_id`/`created_by`/`id` are
stripped automatically (§What survives), so no manual scrubbing is needed.

### 4. Reconcile the non-traveling references

Work down the right-hand column of the table above, in the **target** env:

- **Credentials** — recreate each vault entry the `vault_schema` alias expects:
  ```bash
  cloudcruise vault list --profile prod         # see what's already there
  cloudcruise vault create --profile prod --user-id <id> --domain <d> ...
  ```
  Match the workflow's alias and the entry's **domain** (a domain mismatch surfaces at
  run time as `Credentials for <id> and domain <d> (alias: X) not found`).
- **Error codes** — if nodes carry error-code IDs, confirm equivalents exist in the
  target workspace; recreate/rewire as needed (the CLI won't remap them for you).
- **Components** — `components list --profile prod`; create any missing ones the
  workflow references before it can run.
- **Resource group** — assign it in the target dashboard.
- **encrypted_keys** — confirm the fields that must be encrypted are configured on the
  target workflow (stripped by `update`, so not inherited from the source JSON).

### 5. Verify with a real run

```bash
cloudcruise run start <target_workflow_id> --profile prod --input "$(cat run_input.json)"
cloudcruise run get <session_id> --profile prod      # poll until status is terminal
```

A green run in the target is the only proof the promotion is complete — a workflow that
`update`d cleanly can still fail on a missing credential, dangling error code, or absent
component. Don't call it done until a run passes.

---

## Quickstart

```bash
# profiles configured once (see §The model)
cloudcruise workflows get <src_id> --profile staging > wf.json
# create the target shell in the prod dashboard, copy its id -> <dst_id>
cloudcruise workflows update <dst_id> --file wf.json --profile prod \
  --version-note "Promoted from staging <src_id>"
# reconcile vault creds / error codes / components / resource group in prod
cloudcruise run start <dst_id> --profile prod --input "$(cat run_input.json)"
cloudcruise run get <session_id> --profile prod
```

---

## Gotchas

- **No `workflows create`.** The target id must pre-exist; seed it in the dashboard
  once (step 2). If `update` returns a 404, the id doesn't exist in the target env.
- **Wrong-profile writes are silent-ish.** A `get` from staging piped to an `update`
  without `--profile prod` will hit whatever the *active* profile is. Pass `--profile`
  explicitly on **both** ends every time; don't rely on the active profile.
- **Credentials never copy.** This is by design (workspace-scoped AES). Re-enter them
  in the target — do not attempt to move ciphertext.
- **A clean `update` is not a working workflow.** Error codes, components, and the
  resource group are separate objects; the run in step 5 is what catches their absence.
- **Redis cache caveat.** If you re-promote over an existing target workflow, the
  engine may still serve a cached prior version until the update invalidates it — if a
  run seems to use stale nodes, re-fetch (`workflows get <dst_id> --profile prod`) to
  confirm what actually landed.

> **v1 — refine on use.** The field-survival table and the reconcile list are the
> load-bearing parts; extend them as you hit new cross-env references (e.g. secret
> providers, fingerprint config). When you learn something, edit this file.
