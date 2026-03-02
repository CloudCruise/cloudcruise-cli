import { Command } from "commander"
import { randomUUID } from "crypto"

export function registerUtilsCommands(program: Command): void {
  const utils = program.command("utils").description("Utility commands")

  utils
    .command("uuid")
    .description("Generate random UUIDs for workflow node IDs")
    .option("--count <n>", "Number of UUIDs to generate", "1")
    .action((opts: { count: string }) => {
      const count = Math.max(1, parseInt(opts.count, 10) || 1)
      for (let i = 0; i < count; i++) {
        process.stdout.write(randomUUID() + "\n")
      }
    })
}
