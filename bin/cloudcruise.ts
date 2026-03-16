#!/usr/bin/env node

import { program } from "commander"
import { createRequire } from "module"
import updateNotifier from "update-notifier"
import { registerAuthCommands } from "../src/commands/auth.js"
import { registerWorkflowCommands } from "../src/commands/workflows.js"
import { registerRunCommands } from "../src/commands/run.js"
import { registerInstallCommands } from "../src/commands/install.js"
import { registerUtilsCommands } from "../src/commands/utils.js"
import { registerSnapshotCommands } from "../src/commands/snapshot.js"

const require = createRequire(import.meta.url)
const pkg = require("../../package.json") as { name: string; version: string }

updateNotifier({ pkg }).notify()

program
  .name("cloudcruise")
  .description("CloudCruise CLI for managing workflows and runs")
  .version(pkg.version)

registerAuthCommands(program)
registerWorkflowCommands(program)
registerRunCommands(program)
registerInstallCommands(program)
registerUtilsCommands(program)
registerSnapshotCommands(program)

program.parse()
