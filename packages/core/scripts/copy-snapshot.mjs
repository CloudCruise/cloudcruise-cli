// Copies the bundled spec snapshot into dist. A Node script, not cp, so the build
// also runs under npm's default shell on Windows.
import { copyFileSync, mkdirSync } from "node:fs"

const dist = new URL("../dist/", import.meta.url)
mkdirSync(dist, { recursive: true })
copyFileSync(new URL("../src/openapi.snapshot.json", import.meta.url), new URL("openapi.snapshot.json", dist))
