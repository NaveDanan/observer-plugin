import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const src = (name: string): string => readFileSync(resolve(process.cwd(), "apps/web/src", name), "utf8")
const surfaces = (): string => src("app-surfaces.css")

describe("mobile responsive contracts", () => {
  it("keeps mobile session navigation separate from the desktop list", () => {
    const sidebar = src("SessionSidebar.tsx")
    expect(sidebar).toContain("session-rail-mobile")
    expect(sidebar).toContain("role=\"button\"")
    expect(surfaces()).toMatch(/\.session-rail-mobile[\s\S]*min-height:\s*44px/)
    expect(surfaces()).toContain(".sidebar:not(.is-collapsed) .session-list")
  })

  it("provides safe-area and dynamic viewport sizing for narrow sheets and dialogs", () => {
    const css = surfaces()
    expect(css).toContain("height: min(90dvh, 720px)")
    expect(css).toContain("min-height: 56dvh")
    expect(css).toContain("env(safe-area-inset-bottom)")
    expect(css).toContain(".dialog-overlay")
    expect(src("DetailPanel.tsx")).toContain("role=\"tabpanel\"")
    expect(src("App.tsx")).toContain("aria-controls=\"topbar-goal-text\"")
  })

  it("keeps compact controls usable without page-level horizontal overflow", () => {
    const app = src("App.tsx")
    const canvas = src("Canvas.tsx")
    const settings = src("settings/SettingsPage.tsx")
    const css = surfaces()
    expect(app).toContain("topbar-goal-toggle")
    expect(app).toContain("aria-controls=\"topbar-goal-text\"")
    expect(canvas).toContain("zoom-fit")
    expect(settings).toContain("settings-nav")
    expect(css).toContain("overflow-x: hidden")
    expect(css).toContain("max-width: calc(100% - 24px)")
  })
})
