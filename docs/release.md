# Cutting a release

```bash
pnpm release
```

This runs the full build and then `scripts/build-release.mjs`, producing:

```text
release/observer-ai-<version>.tgz
```

## What the script does, and why

The monorepo uses `workspace:*` dependencies. Those cannot be resolved on
another machine, so publishing the packages as-is would produce something that
installs but cannot start. The release script therefore flattens everything:

1. **Bundles the three entry points** with esbuild into standalone ESM files:

   | Bundle                     | Binary                     | Purpose                        |
   | -------------------------- | -------------------------- | ------------------------------ |
   | `dist/cli.js`              | `observer`                 | install, start, doctor         |
   | `dist/daemon.js`           | `observer-daemon`          | HTTP + WebSocket service       |
   | `dist/emit.js`             | `observer-emit`            | the process host hooks execute |
   | `dist/codex-control.js`    | `observer-codex-control`   | isolates Codex child context   |

   All first-party packages are inlined. Fastify stays external and is declared
   as a real dependency, because bundling a framework with dynamic requires is
   a reliable way to produce a package that fails only in production.

2. **Copies the built UI** to `web/`, plus the OpenCode plugin and the docs.

3. **Writes a fresh `package.json`** with `bin` entries, no workspace
   references, and `engines.node >= 22.5.0`.

4. **Normalises the shebang.** The entry files already start with
   `#!/usr/bin/env node` and esbuild preserves it, so an esbuild `banner` would
   emit a second one on line 2 and every binary would fail to parse. The script
   strips and re-adds exactly one, then verifies none remain in the body.

## Path resolution

The same code runs from two layouts:

```text
monorepo                          published package
  apps/daemon/dist/main.js          dist/daemon.js
  apps/web/dist/                    web/
  packages/hook-emitter/dist/       dist/emit.js
  integrations/opencode/            integrations/opencode/
```

`defaultWebDir()`, `emitterPath()`, `daemonPath()` and `opencodePluginSource()`
probe both layouts and return the first that exists. `observer doctor` checks
each one, so a broken release is caught immediately rather than at first use.

## Verifying a release

Test it the way a new machine would, in an isolated prefix and a clean home:

```bash
export HOME=/tmp/fresh-pc/home
export npm_config_prefix=/tmp/fresh-pc/npm-global
export PATH=$npm_config_prefix/bin:$PATH

npm install -g release/observer-ai-<version>.tgz
observer doctor
observer install all
observer start --port 46100
observer status
```

Then emit a synthetic event through the *installed* emitter and confirm it
reaches the canvas:

```bash
EMIT=$npm_config_prefix/lib/node_modules/observer-ai/dist/emit.js
echo '{"session_id":"t1","source":"startup","model":"claude-opus-5"}' \
  | node $EMIT --host claude --event SessionStart
```

## Versioning

The version comes from the root `package.json`, or `OBSERVER_VERSION` if set:

```bash
OBSERVER_VERSION=0.9.17 pnpm release
```

It is injected into the CLI bundle at build time and reported by
`observer version`, `observer where` and `observer doctor`.

## Distributing

The tarball is self-contained; copy it to the target machine by any means and
`npm install -g` it. To publish to npm instead, run `npm publish` from
`release/package`.

Two install traps, both hit in practice:

- **Always pass the tarball with an explicit path.** Without the leading
  `./`, npm parses `release/observer-ai-0.9.17.tgz` as a GitHub `user/repo`
  shorthand and fails trying to contact git.
- **Never install the staging directory** (`npm i -g ./release/package`).
  Folder installs are symlinked, so `observer` runs from a tree that has no
  `node_modules`, and every invocation dies on the external `fastify` import.
  The tarball is the only supported local artifact.
