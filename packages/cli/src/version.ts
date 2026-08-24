/**
 * The version this build calls itself.
 *
 * `__OBSERVER_VERSION__` is substituted by the release bundler
 * (`scripts/build-release.mjs`), which is the only build that knows a real
 * version — the workspace packages are all `0.1.0` placeholders and the root
 * manifest is not on the module graph. A dev build has no released version to
 * report, and `"dev"` says so rather than naming a number that was never cut.
 *
 * `typeof` rather than a direct read: outside the bundle the identifier does
 * not exist at all, and `typeof` on an undeclared name is the one form that
 * does not throw.
 */
declare const __OBSERVER_VERSION__: string

export const VERSION: string = typeof __OBSERVER_VERSION__ === "string" ? __OBSERVER_VERSION__ : "dev"

/** How the banner says it: `v0.9.5` for a release, `(dev build)` otherwise. */
export function versionLabel(version: string = VERSION): string {
  return version === "dev" ? "(dev build)" : `v${version}`
}
