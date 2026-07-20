#!/usr/bin/env node

import { program } from "commander"
import { createRequire } from "module"
import updateNotifier from "update-notifier"
import { loadDotEnv } from "../src/core/env.js"
import { registerAuthCommands } from "../src/commands/auth.js"
import { registerWorkflowCommands } from "../src/commands/workflows.js"
import { registerComponentCommands } from "../src/commands/components.js"
import { registerRunCommands } from "../src/commands/run.js"
import { registerInstallCommands } from "../src/commands/install.js"
import { registerUtilsCommands } from "../src/commands/utils.js"
import { registerSnapshotCommands } from "../src/commands/snapshot.js"
import { registerVaultCommands } from "../src/commands/vault.js"
import { registerSecretProviderCommands } from "../src/commands/secret-providers.js"
import { registerBuilderCommands } from "../src/commands/builder.js"
import { registerWorkspaceCommands } from "../src/commands/workspaces.js"
import { CLI_VERSION } from "../src/core/version.js"
import { checkInstalledSkills } from "../src/core/skills.js"

const require = createRequire(import.meta.url)
const pkg = require("../../package.json") as { name: string; version: string }

loadDotEnv()

if (process.stderr.isTTY) {
  updateNotifier({ pkg }).notify()
}

program
  .name("cloudcruise")
  .description("CloudCruise CLI for managing workflows and runs")
  .version(CLI_VERSION)

registerAuthCommands(program)
registerWorkflowCommands(program)
registerWorkspaceCommands(program)
registerComponentCommands(program)
registerRunCommands(program)
registerBuilderCommands(program)
registerInstallCommands(program)
registerUtilsCommands(program)
registerSnapshotCommands(program)
registerSecretProviderCommands(program)
registerVaultCommands(program)

// Warn (or, on a breaking release, block) when a project's installed skills have
// drifted from this CLI version. Resolves the invoked command's top-level group
// and only acts on the gated groups; never fires for --help/--version.
program.hook("preAction", (_thisCommand, actionCommand) => {
  let cmd = actionCommand
  while (cmd.parent && cmd.parent.parent) cmd = cmd.parent
  checkInstalledSkills(cmd.name())
})

program.parse()
