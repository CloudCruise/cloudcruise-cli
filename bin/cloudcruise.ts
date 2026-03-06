#!/usr/bin/env node

import { program } from "commander"
import { registerAuthCommands } from "../src/commands/auth.js"
import { registerWorkflowCommands } from "../src/commands/workflows.js"
import { registerRunCommands } from "../src/commands/run.js"
import { registerInstallCommands } from "../src/commands/install.js"
import { registerUtilsCommands } from "../src/commands/utils.js"
import { registerSnapshotCommands } from "../src/commands/snapshot.js"

program
  .name("cloudcruise")
  .description("CloudCruise CLI for managing workflows and runs")
  .version("0.1.4")

registerAuthCommands(program)
registerWorkflowCommands(program)
registerRunCommands(program)
registerInstallCommands(program)
registerUtilsCommands(program)
registerSnapshotCommands(program)

program.parse()
