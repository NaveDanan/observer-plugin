/**
 * Installing a theme from a JSON file.
 *
 * T3 Code's version also searches a hosted gallery, converts VS Code theme
 * files, accepts drag-and-drop, and negotiates id collisions with an
 * "update or keep both" step. Observer ships none of that: there is no gallery
 * to search, and `parseThemeFile` already refuses anything that is not one of
 * our own files, so the dialog is the two doors that remain — paste it or pick
 * it — with the parser's own sentence shown verbatim when it says no.
 */

import { useCallback, useRef, useState } from "react"
import { FileJsonIcon, PlusIcon } from "lucide-react"
import { Button, Dialog } from "../../ui/primitives"
import type { ThemeDefinition } from "../../theme/palettes"
import { installCustomTheme, parseThemeFile } from "../../theme/library"

/**
 * A full export is a few KB. The guard runs on the size before a single byte is
 * read, because reading a large file is what locks the tab, not parsing it.
 */
const MAX_THEME_FILE_BYTES = 256 * 1024

export function ThemeImportDialog({
  open,
  onClose,
  onInstalled,
}: {
  open: boolean
  onClose: () => void
  onInstalled: (theme: ThemeDefinition) => void
}): JSX.Element {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [json, setJson] = useState("")
  const [fileName, setFileName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const close = useCallback(() => {
    setJson("")
    setFileName(null)
    setError(null)
    onClose()
  }, [onClose])

  const readFile = useCallback((file: File): void => {
    if (file.size > MAX_THEME_FILE_BYTES) {
      setError("That file is far larger than any theme file. Paste the JSON below instead.")
      return
    }
    void file
      .text()
      .then((text) => {
        setJson(text)
        setFileName(file.name)
        setError(null)
      })
      .catch(() => setError("That file could not be read. Paste the JSON below instead."))
  }, [])

  const install = (): void => {
    try {
      const theme = installCustomTheme(parseThemeFile(JSON.parse(json) as unknown))
      setJson("")
      setFileName(null)
      setError(null)
      onInstalled(theme)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That theme file is invalid.")
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add a theme"
      description="Paste a theme file, or choose one you exported from Observer or T3 Code."
      footer={
        <>
          <Button variant="outline" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" disabled={json.trim().length === 0} onClick={install}>
            <PlusIcon />
            Install theme
          </Button>
        </>
      }
    >
      <div className="grid gap-3 pb-2">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border/80 bg-muted/20 px-3 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Theme file</p>
            <p className="truncate text-xs text-muted-foreground">{fileName ?? "No file chosen"}</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
            <FileJsonIcon />
            Choose file
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              // Clearing lets the same file be picked twice after a failure.
              event.currentTarget.value = ""
              if (file) readFile(file)
            }}
          />
        </div>

        <div className="grid gap-1.5">
          <label className="text-sm font-medium text-foreground" htmlFor="theme-import-json">
            Theme JSON
          </label>
          <textarea
            id="theme-import-json"
            spellCheck={false}
            value={json}
            placeholder={'{\n  "version": 1,\n  "name": "Aurora",\n  "appearance": "light",\n  "colors": { … }\n}'}
            onChange={(event) => {
              setJson(event.currentTarget.value)
              setError(null)
            }}
            className="block min-h-44 w-full resize-y rounded-xl border border-input bg-background p-3 font-mono text-xs leading-5 text-foreground shadow-xs/5 outline-none transition-shadow placeholder:text-placeholder focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 dark:bg-input/32"
          />
        </div>

        {error !== null ? (
          <p role="alert" className="rounded-lg bg-error-surface px-3 py-2 text-[13px] text-error-foreground">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
