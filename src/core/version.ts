import { createRequire } from "module"

// Single source of the CLI version for every module. `createRequire` is used
// (not a static JSON import) so tsc does not emit a stray `dist/package.json`.
// Path is 3 levels up: dist/src/core → dist/src → dist → <pkg>/package.json.
const require = createRequire(import.meta.url)
const pkg = require("../../../package.json") as { version: string }

export const CLI_VERSION: string = pkg.version
