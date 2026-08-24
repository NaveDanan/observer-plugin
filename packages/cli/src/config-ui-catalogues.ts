import type { HostSeatAdapter, ModelCatalogue } from "@observer-ai/daemon"
import type { TargetProfile } from "./config-ui-state.js"

/**
 * Loads Copilot's catalogue before the first frame, so opening its target never
 * depends on a first keypress winning a cold-process race.
 *
 * Empty answers are deliberately omitted. Opening the target then asks again,
 * which lets a CLI that was still starting recover in the same TUI session.
 */
export function preloadCopilotCatalogues(
  adapters: HostSeatAdapter[],
  profiles: TargetProfile[],
): Record<string, ModelCatalogue> {
  const catalogues: Record<string, ModelCatalogue> = {}
  for (const profile of profiles) {
    if (profile.host !== "copilot") continue
    const catalogue = loadTargetCatalogue(adapters, profiles, profile.id)
    if (catalogue.models.length > 0) catalogues[profile.id] = catalogue
  }
  return catalogues
}

export function loadTargetCatalogue(
  adapters: HostSeatAdapter[],
  profiles: TargetProfile[],
  targetId: string,
): ModelCatalogue {
  const profile = profiles.find((entry) => entry.id === targetId)
  if (profile === undefined) {
    return {
      models: [],
      source: targetId,
      freshness: "unknown",
      warnings: [`No adapter profile claims "${targetId}". Type a model id or remove this target.`],
    }
  }
  const adapter = adapters.find((entry) => entry.kind === profile.host)
  if (adapter === undefined) {
    return {
      models: [],
      source: targetId,
      freshness: "unknown",
      warnings: [`No adapter in this build claims "${profile.host}".`],
    }
  }
  return adapter.catalogue(profile.id)
}
