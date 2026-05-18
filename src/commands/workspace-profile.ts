import { Command } from "commander"
import { loadProfile, resolveProfileName, saveProfile } from "../core/config.js"
import { outputJson } from "../core/output.js"

export function commandProfileOption(
  opts: { profile?: string },
  cmd?: Command
): string | undefined {
  const parsed = opts.profile ?? cmd?.opts<{ profile?: string }>().profile
  if (parsed) return parsed

  const profileEq = process.argv.find((arg) => arg.startsWith("--profile="))
  if (profileEq) return profileEq.slice("--profile=".length)

  const profileIndex = process.argv.indexOf("--profile")
  if (profileIndex >= 0) return process.argv[profileIndex + 1]

  return undefined
}

export function showWorkspaceProfile(opts: { profile?: string }, cmd?: Command): void {
  const profileName = resolveProfileName(commandProfileOption(opts, cmd))
  const profile = loadProfile(profileName)
  outputJson({
    status: "ok",
    profile: profileName,
    workspace_id: profile.currentWorkspaceId ?? null,
  })
}

export function useWorkspaceProfile(
  id: string,
  opts: { profile?: string },
  cmd?: Command
): void {
  const profileName = resolveProfileName(commandProfileOption(opts, cmd))
  const profile = loadProfile(profileName)
  profile.currentWorkspaceId = id
  saveProfile(profileName, profile)
  outputJson({
    status: "ok",
    profile: profileName,
    workspace_id: profile.currentWorkspaceId,
  })
}

export function clearWorkspaceProfile(opts: { profile?: string }, cmd?: Command): void {
  const profileName = resolveProfileName(commandProfileOption(opts, cmd))
  const profile = loadProfile(profileName)
  delete profile.currentWorkspaceId
  saveProfile(profileName, profile)
  outputJson({ status: "ok", profile: profileName, workspace_id: null })
}
