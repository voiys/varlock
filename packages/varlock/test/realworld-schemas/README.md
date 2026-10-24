# Real-world schema fixtures

`.env.schema` files from public GitHub repositories, frozen at a pinned commit and checked in, so
varlock changes can be tested against schemas people actually write. Each fixture is the schema
plus the env files it `@import`s, copied byte for byte under `fixtures/<id>/` with the repository's
own folder layout.

These files are untrusted input. The rules:

- Tests never fetch anything at run time. Everything they read is in this folder.
- Tests never run anything from these files. `realworld-schemas.test.ts` loads every fixture with
  `new EnvGraph({ mode: 'shape' })` only, so `exec()`, root decorators (`@initOp`,
  `@setValuesBulk`, ...), secret providers and plugin downloads never run. The test also replaces
  `child_process`, `http`, `https` and `fetch` with versions that record and refuse every call,
  asserts nothing was attempted, asserts no plugin was imported, and points the varlock config
  dir at an empty temp folder so a maintainer's own plugin cache is never used. Two positive
  controls show these guards do catch varlock spawning a process and downloading a plugin.
- Only env-spec text files are frozen. No code, no plugins, no `.local` files. A schema that loads
  a local plugin (`@plugin(./...)`) or imports outside its own repository cannot be added.
- Only repositories whose license allows copying with attribution are used (MIT, Apache-2.0,
  BSD, ISC, MPL-2.0, Unlicense, CC0 and similar; see `ALLOWED_LICENSES` in
  `fixture-manifest.ts`). The license is checked at the pinned commit. Attribution for every file
  is in `manifest.json` and `NOTICE.md`.
- Every change here is a reviewable diff: fixture bytes are pinned by sha256 in `manifest.json`,
  and what varlock sees is pinned by `snapshots/<id>.json`.

## What the test checks

For each fixture, after checking every file against its manifest sha256, the test loads the
schema in shape mode and compares with `snapshots/<id>.json`:

- item keys in load order, with data type, required (`true`, `false` or `"dynamic"`) and
  sensitive flags
- every error and warning from the data sources and items, with absolute paths replaced by
  `<fixture>`
- what shape mode skipped (`shapeSkipped`)

A fixture with errors (warnings aside) must say why in its manifest `expectErrors` field, and a
fixture without errors must not have one. Most expected errors are `@plugin(@varlock/...)` lines:
plugins are never installed for these tests, and the workspace plugin packages under
`packages/plugins` are not resolvable from here, so loading stops at the `@plugin` line. The rest
are real defects in the upstream schema.

The first test runs the offline integrity check from `fixture-manifest.ts` (what `verify` below
runs, minus the gitignore check).

## Updating snapshots

Snapshots only change when asked:

```sh
cd packages/varlock
REALWORLD_SCHEMAS_UPDATE=1 bunx vitest run test/realworld-schemas
```

Review the snapshot diff like any other code change. A diff you did not expect is a behavior
change in varlock.

## Adding a fixture

Adding a fixture is a deliberate step that someone reviews. Nothing adds fixtures automatically.

```sh
cd packages/varlock
bun run scripts/realworld-fixtures.ts add <owner/repo> <path/to/.env.schema> [--commit <sha>]
REALWORLD_SCHEMAS_UPDATE=1 bunx vitest run test/realworld-schemas
bun run scripts/realworld-fixtures.ts verify
```

`add` needs the `gh` CLI (it only reads from the GitHub API). It resolves the commit (default:
the default branch HEAD), checks the license at that commit, downloads the schema and its
`@import` targets as text, refuses anything that looks like a live credential, and writes the
files, the manifest entry and `NOTICE.md`. It never downloads plugins and never parses the files
with varlock. Then:

1. Read the new files and the new snapshot.
2. If the snapshot has errors, add an `expectErrors` explanation to the manifest entry.
3. Commit the fixture, snapshot, manifest and `NOTICE.md` together.

Other commands:

- `verify`: offline check that every file matches its sha256, nothing unlisted is on disk, every
  entry has an allowed license and attribution, `NOTICE.md` is current and no fixture file is
  gitignored.
- `refresh [id ...]`: reports how upstream moved on since the pinned commit (changed or removed
  files, license changes). It never writes anything. To take a new version, run `add` again with
  `--commit <sha> --replace` and review the diff.
- `remove <id>`: deletes a fixture, its snapshot and its manifest entry.
- `notice`: rewrites `NOTICE.md` from `manifest.json`.
