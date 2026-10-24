#!/usr/bin/env bun

/**
 * Maintains the frozen real-world schema fixtures in `test/realworld-schemas/`. Manual tool for
 * maintainers, not run in CI (the vitest suite runs the offline `verify` check itself).
 *
 *   bun run scripts/realworld-fixtures.ts add <owner/repo> <path> [--commit <sha>] [--replace]
 *   bun run scripts/realworld-fixtures.ts remove <fixture-id>
 *   bun run scripts/realworld-fixtures.ts verify
 *   bun run scripts/realworld-fixtures.ts refresh [fixture-id ...]
 *   bun run scripts/realworld-fixtures.ts notice
 *
 * (paths are relative to packages/varlock)
 *
 * `add` downloads the schema and the env files it @imports as text, at one pinned commit, through
 * the GitHub API (`gh api`, read only). It refuses the repo unless its license at that commit is
 * in ALLOWED_LICENSES, refuses schemas that load local plugin code or import outside the repo,
 * and records repo, commit, path, license and a sha256 per file in manifest.json. It never
 * downloads plugins or any other code, and never runs, imports or evaluates what it downloads:
 * the files are only scanned as text to find @import and @plugin targets.
 *
 * After `add`, create the snapshot with
 *   REALWORLD_SCHEMAS_UPDATE=1 bunx vitest run test/realworld-schemas
 * and review the new fixture, its snapshot and manifest entry like any other change. If the
 * snapshot has errors, explain them in the entry's `expectErrors` field. Adding a fixture is a
 * deliberate, reviewed step; nothing here runs on its own.
 *
 * `verify` is offline: every frozen file matches its manifest sha256, nothing unlisted is on
 * disk, every entry has an allowed license and attribution, NOTICE.md is current, and no fixture
 * file is gitignored.
 *
 * `refresh` only reports how each fixture's upstream differs from the frozen copy (new commits on
 * the default branch, changed or removed files, license changes). It never writes anything.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  ALLOWED_LICENSES, FIXTURES_DIR, MAX_FILE_BYTES, NOTICE_PATH, REALWORLD_DIR, SNAPSHOTS_DIR,
  decoratorFirstArgs, findSecretLookingStrings, fixtureId, isFreezableFileName, isLocalPluginSource,
  isSafeRelativePath, readManifest, renderNotice, sha256, verifyFixtures, writeManifest,
  type FixtureEntry,
} from '../test/realworld-schemas/fixture-manifest';

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    commit: { type: 'string' },
    replace: { type: 'boolean', default: false },
  },
});
const [command, ...args] = positionals;

class UsageError extends Error {}

// --- GitHub, read only -------------------------------------------------------------------------

function ghApi(endpoint: string, opts?: { raw?: boolean }): Buffer | undefined {
  const ghArgs = ['api', '--method', 'GET'];
  if (opts?.raw) ghArgs.push('-H', 'Accept: application/vnd.github.raw');
  ghArgs.push(endpoint);
  try {
    return execFileSync('gh', ghArgs, { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const stderr = String((err as { stderr?: Buffer }).stderr ?? '');
    if (/HTTP 404|Not Found/.test(stderr)) return undefined;
    throw new Error(`gh api ${endpoint} failed: ${stderr.trim() || (err as Error).message}`);
  }
}
const ghJson = <T>(endpoint: string) => {
  const out = ghApi(endpoint);
  return out === undefined ? undefined : JSON.parse(out.toString('utf8')) as T;
};
const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

function resolveCommit(repo: string, ref: string) {
  const res = ghJson<{ sha: string }>(`repos/${repo}/commits/${encodeURIComponent(ref)}`);
  if (!res?.sha) throw new Error(`${repo}: cannot resolve ${ref}`);
  return res.sha;
}

function getLicense(repo: string, commit: string) {
  const res = ghJson<{ path: string, license?: { spdx_id?: string } }>(`repos/${repo}/license?ref=${commit}`);
  return res ? { spdx: res.license?.spdx_id ?? 'NOASSERTION', file: res.path } : undefined;
}

function getTree(repo: string, commit: string) {
  const res = ghJson<{ truncated: boolean, tree: Array<{ path: string, type: string }> }>(`repos/${repo}/git/trees/${commit}?recursive=1`);
  if (!res) throw new Error(`${repo}: cannot list files at ${commit}`);
  if (res.truncated) throw new Error(`${repo}: file list at ${commit} is truncated; this script does not handle repos that large`);
  return new Set(res.tree.filter((x) => x.type === 'blob').map((x) => x.path));
}

/** file text at a commit, or undefined when it does not exist */
function getFileText(repo: string, commit: string, repoPath: string) {
  const buf = ghApi(`repos/${repo}/contents/${encodePath(repoPath)}?ref=${commit}`, { raw: true });
  if (buf === undefined) return undefined;
  if (buf.length > MAX_FILE_BYTES) throw new Error(`${repo}: ${repoPath} is larger than ${MAX_FILE_BYTES} bytes`);
  if (buf.includes(0)) throw new Error(`${repo}: ${repoPath} is not a text file`);
  return buf;
}

// --- collecting a schema and its imports (text scan only) --------------------------------------

type Collected = { files: Map<string, Buffer>, plugins: Set<string>, unresolved: Set<string> };

function collect(repo: string, commit: string, entryPath: string): Collected {
  const tree = getTree(repo, commit);
  const files = new Map<string, Buffer>();
  const plugins = new Set<string>();
  const unresolved = new Set<string>();
  const dirsDone = new Set<string>();

  const fetchFile = (p: string) => {
    if (files.has(p)) return files.get(p);
    if (!tree.has(p)) return undefined;
    if (!isFreezableFileName(path.posix.basename(p))) throw new Error(`${p} is not an env-spec file name; refusing to copy it`);
    const buf = getFileText(repo, commit, p);
    if (buf) files.set(p, buf);
    return buf;
  };

  const visit = (p: string, depth: number) => {
    const buf = fetchFile(p);
    if (!buf) {
      unresolved.add(p);
      return;
    }
    if (depth > 10) throw new Error(`@import chain deeper than 10 at ${p}`);
    const text = buf.toString('utf8');
    for (const source of decoratorFirstArgs(text, 'plugin')) {
      if (isLocalPluginSource(source)) {
        throw new Error(`${p} loads local plugin code (${source}); fixtures never include code, so this schema cannot be frozen`);
      }
      plugins.add(source);
    }
    const dir = path.posix.dirname(p);
    for (const imp of decoratorFirstArgs(text, 'import')) {
      if (!imp) continue;
      if (!imp.startsWith('./') && !imp.startsWith('../') && imp !== '.' && imp !== '..') {
        throw new Error(`${p} has a non-relative @import (${imp}); refusing`);
      }
      const resolved = path.posix.normalize(path.posix.join(dir, imp));
      if (resolved.startsWith('..')) throw new Error(`${p} imports outside the repo (${imp}); refusing`);
      const isDir = imp.endsWith('/') || imp === '.' || imp === '..';
      const rel = resolved === '.' ? '' : resolved.replace(/\/$/, '');
      if (isDir) {
        if (dirsDone.has(rel)) continue;
        dirsDone.add(rel);
        // a directory import loads .env.schema, .env and .env.<currentEnv>; currentEnv is not known
        // statically, so take every non-local env file in that folder
        const names = [...tree]
          .filter((x) => path.posix.dirname(x) === (rel || '.'))
          .filter((x) => isFreezableFileName(path.posix.basename(x)))
          .filter((x) => !/\.(?:example|sample|template|bak)$/.test(x));
        if (!names.length) unresolved.add(`${rel || '.'}/`);
        for (const n of names) if (!files.has(n)) visit(n, depth + 1);
      } else if (!files.has(rel)) {
        if (rel.endsWith('.local') || !tree.has(rel)) {
          unresolved.add(rel);
          continue;
        }
        visit(rel, depth + 1);
      }
    }
  };

  visit(entryPath, 0);
  if (!files.has(entryPath)) throw new Error(`${repo}: ${entryPath} does not exist at ${commit}`);
  return { files, plugins, unresolved };
}

// --- commands ----------------------------------------------------------------------------------

function cmdAdd() {
  const [repo, entryPath] = args;
  if (!repo || !entryPath || args.length !== 2) throw new UsageError('add needs <owner/repo> <path>');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new UsageError(`not an owner/repo: ${repo}`);
  if (!isSafeRelativePath(entryPath)) throw new UsageError(`not a repo-relative path: ${entryPath}`);
  if (!isFreezableFileName(path.posix.basename(entryPath))) throw new UsageError(`not an env-spec file name: ${entryPath}`);

  const id = fixtureId(repo, entryPath);
  const manifest = readManifest();
  const existing = manifest.fixtures.find((f) => f.id === id);
  if (existing && !flags.replace) throw new UsageError(`${id} already exists at ${existing.commit}; pass --replace to re-freeze it`);

  const commit = flags.commit && /^[0-9a-f]{40}$/.test(flags.commit) ? flags.commit : resolveCommit(repo, flags.commit ?? 'HEAD');
  const license = getLicense(repo, commit);
  if (!license) throw new Error(`${repo}@${commit}: no license file; not freezing it`);
  if (!(ALLOWED_LICENSES as ReadonlyArray<string>).includes(license.spdx)) {
    throw new Error(`${repo}@${commit}: license ${license.spdx} (${license.file}) is not in the allowed list; not freezing it`);
  }

  const { files, plugins, unresolved } = collect(repo, commit, entryPath);
  for (const [p, buf] of files) {
    const hits = findSecretLookingStrings(buf.toString('utf8'));
    if (hits.length) throw new Error(`${p} contains a ${hits.join(', ')}; not freezing it`);
  }

  const dir = path.join(FIXTURES_DIR, id);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [p, buf] of files) {
    const fp = path.join(dir, ...p.split('/'));
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, buf);
  }
  const entry: FixtureEntry = {
    id,
    repo,
    commit,
    path: entryPath,
    url: `https://github.com/${repo}/blob/${commit}/${entryPath}`,
    license,
    files: Object.fromEntries([...files.keys()].sort().map((p) => [p, sha256(files.get(p)!)])),
    plugins: [...plugins].sort(),
    unresolved: [...unresolved].sort(),
    ...existing?.expectErrors ? { expectErrors: existing.expectErrors } : {},
    addedAt: new Date().toISOString().slice(0, 10),
  };
  manifest.fixtures = manifest.fixtures.filter((f) => f.id !== id).concat(entry);
  writeManifest(manifest);
  fs.writeFileSync(NOTICE_PATH, renderNotice(manifest));

  console.log(`froze ${id}: ${files.size} file(s) at ${commit}, license ${license.spdx}`);
  if (plugins.size) console.log(`  plugins (not downloaded): ${[...plugins].join(', ')}`);
  if (unresolved.size) console.log(`  not frozen: ${[...unresolved].join(', ')}`);
  console.log('next: REALWORLD_SCHEMAS_UPDATE=1 bunx vitest run test/realworld-schemas, then review the diff');
}

function cmdRemove() {
  const [id] = args;
  if (!id) throw new UsageError('remove needs <fixture-id>');
  const manifest = readManifest();
  if (!manifest.fixtures.some((f) => f.id === id)) throw new UsageError(`no fixture ${id}`);
  manifest.fixtures = manifest.fixtures.filter((f) => f.id !== id);
  fs.rmSync(path.join(FIXTURES_DIR, id), { recursive: true, force: true });
  fs.rmSync(path.join(SNAPSHOTS_DIR, `${id}.json`), { force: true });
  writeManifest(manifest);
  fs.writeFileSync(NOTICE_PATH, renderNotice(manifest));
  console.log(`removed ${id}`);
}

function cmdVerify() {
  const problems = verifyFixtures();
  // a gitignored fixture file would silently be left out of a commit
  const allFiles = readManifest().fixtures.flatMap((e) => Object.keys(e.files).map((rel) => path.join(FIXTURES_DIR, e.id, ...rel.split('/'))));
  let ignored = '';
  try {
    ignored = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: REALWORLD_DIR, input: allFiles.join('\n'), encoding: 'utf8' });
  } catch (err) {
    // exit code 1 means nothing is ignored
    if ((err as { status?: number }).status !== 1) throw err;
  }
  for (const f of ignored.split('\n').filter(Boolean)) problems.push(`gitignored: ${path.relative(REALWORLD_DIR, f)}`);

  const manifest = readManifest();
  if (problems.length) {
    console.error(`FAIL: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  const fileCount = manifest.fixtures.reduce((n, e) => n + Object.keys(e.files).length, 0);
  const repos = new Set(manifest.fixtures.map((e) => e.repo)).size;
  console.log(`OK: ${manifest.fixtures.length} fixtures, ${fileCount} files, ${repos} repos`);
}

function cmdRefresh() {
  const manifest = readManifest();
  const selected = args.length ? manifest.fixtures.filter((f) => args.includes(f.id)) : manifest.fixtures;
  if (args.length && selected.length !== args.length) throw new UsageError('unknown fixture id');
  let changes = 0;
  for (const e of selected) {
    let head: string;
    try {
      head = resolveCommit(e.repo, 'HEAD');
    } catch (err) {
      console.log(`${e.id}: upstream unavailable (${(err as Error).message})`);
      changes++;
      continue;
    }
    if (head === e.commit) {
      console.log(`${e.id}: up to date`);
      continue;
    }
    const notes: Array<string> = [];
    for (const [rel, want] of Object.entries(e.files)) {
      const buf = getFileText(e.repo, head, rel);
      if (!buf) notes.push(`${rel} removed`);
      else if (sha256(buf) !== want) notes.push(`${rel} changed`);
    }
    const license = getLicense(e.repo, head);
    if (license?.spdx !== e.license.spdx) notes.push(`license ${e.license.spdx} -> ${license?.spdx ?? 'none'}`);
    if (notes.length) changes++;
    console.log(`${e.id}: upstream at ${head.slice(0, 12)} (frozen ${e.commit.slice(0, 12)}): ${notes.length ? notes.join(', ') : 'frozen files unchanged'}`);
  }
  console.log(`\n${changes} fixture(s) differ upstream. Nothing was written. To take a new version, review it and run:`);
  console.log('  bun run scripts/realworld-fixtures.ts add <owner/repo> <path> --commit <sha> --replace');
}

function cmdNotice() {
  fs.writeFileSync(NOTICE_PATH, renderNotice(readManifest()));
  console.log(`wrote ${path.relative(process.cwd(), NOTICE_PATH)}`);
}

const commands: Record<string, () => void> = {
  add: cmdAdd, remove: cmdRemove, verify: cmdVerify, refresh: cmdRefresh, notice: cmdNotice,
};
try {
  const run = commands[command ?? ''];
  if (!run) throw new UsageError(`usage: realworld-fixtures.ts <${Object.keys(commands).join('|')}> ...`);
  run();
} catch (err) {
  console.error(err instanceof UsageError ? err.message : `error: ${(err as Error).message}`);
  process.exitCode = err instanceof UsageError ? 2 : 1;
}
