import { Command } from "commander"
import { mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { resolveAuth } from "../core/auth.js"
import { ApiClient } from "../core/api-client.js"
import { outputJson, outputError } from "../core/output.js"
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js"
import {
  suggestAll,
  parseSnapshot,
  evalXPath,
  getMeaningfulAttributes,
  getVisibleText
} from "../core/xpath-suggest.js"

interface SnapshotScreenshot {
  signed_screenshot_url: string
  node_display_name: string
  node_id: string
  timestamp: string
  error_screenshot: boolean
  retry_index: number
  full_length_screenshot: boolean
  metadata: Record<string, unknown>
}

interface DebugSnapshotResponse {
  page_snapshot_url?: string
  screenshots?: SnapshotScreenshot[]
}

interface RunResponse {
  screenshot_urls?: SnapshotScreenshot[]
}

async function downloadFile(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Download failed (${res.status}): ${url}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

function screenshotFilename(
  screenshot: SnapshotScreenshot,
  index: number
): string {
  const parts: string[] = ["screenshot"]
  if (screenshot.error_screenshot) parts.push("error")
  if (screenshot.full_length_screenshot) parts.push("full")
  if (screenshot.retry_index > 0) parts.push(`retry${screenshot.retry_index}`)
  if (index > 0) parts.push(String(index))
  return parts.join("_") + ".jpeg"
}

export function registerSnapshotCommands(program: Command): void {
  const snapshot = program
    .command("snapshot")
    .description("Work with debug snapshots from runs")

  addAuthOptions(
    snapshot
      .command("fetch <session_id> <node_id>")
      .description(
        "Download snapshot HTML, screenshots, and metadata for a node"
      )
      .option("--output-dir <dir>", "Directory to save files", "./snapshots")
      .option("--html", "Download only the HTML snapshot")
      .option("--image", "Download only the screenshot(s)")
  ).action(
    async (
      sessionId: string,
      nodeId: string,
      opts: {
        outputDir: string
        html?: boolean
        image?: boolean
      } & AuthOptions
    ) => {
      try {
        const auth = resolveAuth(opts)
        const client = new ApiClient(auth)

        const downloadAll = !opts.html && !opts.image
        const wantHtml = downloadAll || !!opts.html
        const wantImage = downloadAll || !!opts.image

        const snapshotData = await client.get<DebugSnapshotResponse>(
          `/run/${sessionId}/debug-snapshots/${nodeId}`
        )

        let screenshots = snapshotData.screenshots ?? []

        if (screenshots.length === 0) {
          const runData = await client.get<RunResponse>(
            `/run/${sessionId}`
          )
          screenshots =
            runData.screenshot_urls?.filter((s) => s.node_id === nodeId) ?? []
        }

        const dir = opts.outputDir
        mkdirSync(dir, { recursive: true })

        const saved: string[] = []

        if (wantHtml && snapshotData.page_snapshot_url) {
          const html = await downloadFile(snapshotData.page_snapshot_url)
          const htmlPath = join(dir, "page.html")
          writeFileSync(htmlPath, html)
          saved.push(htmlPath)
        }

        if (wantImage) {
          for (let i = 0; i < screenshots.length; i++) {
            const s = screenshots[i]
            const filename = screenshotFilename(s, i)
            const imgData = await downloadFile(s.signed_screenshot_url)
            const imgPath = join(dir, filename)
            writeFileSync(imgPath, imgData)
            saved.push(imgPath)
          }
        }

        const metadata = {
          session_id: sessionId,
          node_id: nodeId,
          node_name: screenshots[0]?.node_display_name ?? null,
          timestamp: screenshots[0]?.timestamp ?? null,
          has_html_snapshot: !!snapshotData.page_snapshot_url,
          screenshots: screenshots.map((s, i) => ({
            filename: screenshotFilename(s, i),
            error_screenshot: s.error_screenshot,
            full_length_screenshot: s.full_length_screenshot,
            retry_index: s.retry_index,
            metadata: s.metadata,
            timestamp: s.timestamp
          }))
        }

        if (downloadAll) {
          const metaPath = join(dir, "metadata.json")
          writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + "\n")
          saved.push(metaPath)
        }

        outputJson({ saved, ...metadata })
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )

  addAuthOptions(
    snapshot
      .command("suggest [session_id] [node_id]")
      .description(
        "Suggest unique XPath selectors for interactive elements in a snapshot"
      )
      .option(
        "--filter <tags>",
        "Comma-separated HTML tags to include",
        "input,button,select,textarea,a"
      )
      .option("--file <path>", "Use a local HTML file instead of fetching from API")
  ).action(
    async (
      sessionId: string | undefined,
      nodeId: string | undefined,
      opts: {
        filter: string
        file?: string
      } & AuthOptions
    ) => {
      try {
        let html: string

        if (opts.file) {
          html = readFileSync(opts.file, "utf-8")
        } else {
          if (!sessionId || !nodeId) {
            throw new Error(
              "session_id and node_id are required when --file is not provided"
            )
          }
          const auth = resolveAuth(opts)
          const client = new ApiClient(auth)
          const snapshotData = await client.get<DebugSnapshotResponse>(
            `/run/${sessionId}/debug-snapshots/${nodeId}`
          )
          if (!snapshotData.page_snapshot_url) {
            throw new Error(
              "No HTML snapshot available for this node. Run with --debug to capture snapshots."
            )
          }
          const buf = await downloadFile(snapshotData.page_snapshot_url)
          html = buf.toString("utf-8")
        }

        const filter = opts.filter.split(",").map((t) => t.trim())
        const elements = suggestAll(html, filter)

        outputJson({
          element_count: elements.length,
          elements
        })
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )

  addAuthOptions(
    snapshot
      .command("test <xpath> [session_id] [node_id]")
      .description(
        "Test an XPath selector against a snapshot and show matched elements"
      )
      .option("--file <path>", "Use a local HTML file instead of fetching from API")
      .option("--count", "Only return match count, skip element details")
  ).action(
    async (
      xpath: string,
      sessionId: string | undefined,
      nodeId: string | undefined,
      opts: {
        file?: string
        count?: boolean
      } & AuthOptions
    ) => {
      try {
        let html: string

        if (opts.file) {
          html = readFileSync(opts.file, "utf-8")
        } else {
          if (!sessionId || !nodeId) {
            throw new Error(
              "session_id and node_id are required when --file is not provided"
            )
          }
          const auth = resolveAuth(opts)
          const client = new ApiClient(auth)
          const snapshotData = await client.get<DebugSnapshotResponse>(
            `/run/${sessionId}/debug-snapshots/${nodeId}`
          )
          if (!snapshotData.page_snapshot_url) {
            throw new Error(
              "No HTML snapshot available for this node. Run with --debug to capture snapshots."
            )
          }
          const buf = await downloadFile(snapshotData.page_snapshot_url)
          html = buf.toString("utf-8")
        }

        const doc = parseSnapshot(html)
        let matches: Node[]
        try {
          matches = evalXPath(xpath, doc)
        } catch (xpathErr: unknown) {
          throw new Error(
            `Invalid XPath: ${xpathErr instanceof Error ? xpathErr.message : String(xpathErr)}`
          )
        }

        const matchCount = matches.length

        if (opts.count) {
          outputJson({
            xpath,
            match_count: matchCount,
            unique: matchCount === 1
          })
          return
        }

        const elements = matches.map((node, i) => {
          const el = node as Element
          return {
            index: i,
            tag: el.localName ?? el.nodeName,
            attributes: getMeaningfulAttributes(el),
            text: getVisibleText(el)
          }
        })

        outputJson({
          xpath,
          match_count: matchCount,
          unique: matchCount === 1,
          matches: elements
        })
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    }
  )
}
