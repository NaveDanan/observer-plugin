import { describe, expect, it } from "vitest"
import { FILE_ICONS, ICON_BY_EXTENSION, ICON_BY_NAME } from "../src/chat/fileIcons.generated"

/**
 * The generated table is only useful if the extensions this transcript
 * actually shows are in it, and if every name it points at resolves to real
 * artwork. Both are cheap to check and expensive to notice by eye: a missing
 * entry degrades silently to the fallback glyph.
 */
describe("file type icons", () => {
  const everyday = ["ts", "tsx", "js", "jsx", "json", "md", "css", "html", "py", "rs", "go", "sh", "yml", "toml", "svg"]

  it.each(everyday)("knows what a .%s file is", (extension) => {
    const name = ICON_BY_EXTENSION[extension]
    expect(name, `no icon mapped for .${extension}`).toBeDefined()
    expect(FILE_ICONS[name as string]).toBeDefined()
  })

  it("prefers the tool's own mark for files named after it", () => {
    expect(ICON_BY_NAME["package.json"]).toBe("file-type-npm")
    expect(ICON_BY_NAME["pnpm-lock.yaml"]).toBe("file-type-pnpm")
    expect(ICON_BY_NAME["dockerfile"]).toBe("file-type-docker")
  })

  it("points every mapping at artwork that exists", () => {
    for (const name of [...Object.values(ICON_BY_NAME), ...Object.values(ICON_BY_EXTENSION)]) {
      expect(FILE_ICONS[name], `${name} is missing from FILE_ICONS`).toBeDefined()
    }
  })

  it("carries a viewBox with every body, so nothing renders at the wrong scale", () => {
    for (const [name, icon] of Object.entries(FILE_ICONS)) {
      expect(icon.body.length, `${name} has an empty body`).toBeGreaterThan(0)
      expect(icon.viewBox, `${name} has no viewBox`).toMatch(/^0 0 [\d.]+ [\d.]+$/)
    }
  })
})
