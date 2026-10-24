/**
 * Shared helpers for the frozen real-world schema fixtures in this folder.
 *
 * Used by the vitest suite (`realworld-schemas.test.ts`) and by the maintainer script
 * (`scripts/realworld-fixtures.ts`). Everything here treats fixture files as plain text:
 * nothing is parsed by varlock, imported or evaluated.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REALWORLD_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(REALWORLD_DIR, 'fixtures');
export const SNAPSHOTS_DIR = path.join(REALWORLD_DIR, 'snapshots');
export const MANIFEST_PATH = path.join(REALWORLD_DIR, 'manifest.json');
export const NOTICE_PATH = path.join(REALWORLD_DIR, 'NOTICE.md');

/**
 * Licenses that allow copying a file into this repo with attribution (SPDX ids, as reported by
 * the GitHub license API). Anything else, including no license and NOASSERTION, is refused.
 */
export const ALLOWED_LICENSES = [
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSL-1.0', // Boost Software License (not the Business Source License, which is BUSL-1.1)
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Unlicense',
  'Zlib',
] as const;

/** a frozen file must be at most this big */
export const MAX_FILE_BYTES = 256 * 1024;

export type FixtureEntry = {
  /** folder name under fixtures/ and snapshots/: `<owner>__<repo>__<path with / as __>` */
  id: string,
  /** GitHub `owner/repo` */
  repo: string,
  /** full commit sha every file was taken from */
  commit: string,
  /** repo-relative path of the schema that the test loads */
  path: string,
  /** link to the schema at that commit */
  url: string,
  license: {
    /** SPDX id reported by GitHub for the repo at that commit */
    spdx: string,
    /** repo-relative path of the license file at that commit */
    file: string,
  },
  /** every frozen file (the schema and its @import targets), repo-relative path to sha256 */
  files: Record<string, string>,
  /** npm plugins named by `@plugin(...)`; never downloaded or installed */
  plugins: Array<string>,
  /** @import targets that were not frozen (missing at that commit, or allowMissing local files) */
  unresolved: Array<string>,
  /**
   * Why varlock reports errors for this fixture. Required when the snapshot has errors, and must
   * be absent when it has none, so every expected error is explained in review.
   */
  expectErrors?: string,
  /** YYYY-MM-DD */
  addedAt: string,
};

export type FixtureManifest = {
  fixtures: Array<FixtureEntry>,
};

export function fixtureId(repo: string, repoPath: string) {
  return `${repo.replace('/', '__')}__${repoPath.replace(/\//g, '__')}`;
}

export function sha256(data: string | Buffer) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

const CODE_EXTENSION = /\.(?:[cm]?[jt]sx?|json|node|wasm|sh|py|exe|dll|so|dylib)$/i;
/**
 * Only env-spec text files are frozen: `.env`, `.env.schema`, `.env.<anything>`, and names like
 * `vanilla.env.schema`. Code files and `.local` files (gitignored here, usually secrets) never are.
 */
export function isFreezableFileName(fileName: string) {
  if (CODE_EXTENSION.test(fileName)) return false;
  if (fileName.endsWith('.local')) return false;
  return /^[A-Za-z0-9_-]*\.env(?:\.[A-Za-z0-9_-]+)*$/.test(fileName);
}

/** a repo-relative path that stays inside the repo, with forward slashes and no `.` or `..` parts */
export function isSafeRelativePath(p: string) {
  if (!p || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  return p.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * Strings that look like real credentials. A fixture containing one is refused: these files are
 * public already, but this repo should not carry live-looking secrets.
 */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['AWS access key id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['Stripe live key', /\b[sr]k_live_[A-Za-z0-9]{16,}/],
  ['OpenAI or Anthropic key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/],
  // a key body must follow, so a comment that only mentions the header is fine
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\\n|\s)*[A-Za-z0-9+/=]{40}/],
];

export function findSecretLookingStrings(text: string) {
  return SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

/**
 * First argument of every `@<name>(...)` call in the text (comment prefixes removed), from a
 * plain text scan. Quotes are stripped. Good enough to find @import and @plugin targets without
 * running the env-spec parser on untrusted input.
 */
export function decoratorFirstArgs(text: string, name: 'import' | 'plugin') {
  const body = text.split(/\r?\n/).map((l) => l.replace(/^\s*#\s?/, '')).join('\n');
  const re = new RegExp(`@${name}\\(`, 'g');
  const out: Array<string> = [];
  for (const m of body.matchAll(re)) {
    let depth = 1;
    let quote: string | null = null;
    let first = true;
    let arg = '';
    for (let i = m.index + m[0].length; i < body.length && depth > 0; i++) {
      const c = body[i];
      if (quote) {
        if (c === quote) quote = null;
        else if (first) arg += c;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === ',' && depth === 1) first = false;
      else if (first && depth === 1 && !/\s/.test(c)) arg += c;
    }
    out.push(arg);
  }
  return out;
}

/** a plugin source that points at local code rather than an npm package name */
export function isLocalPluginSource(source: string) {
  return source.startsWith('.') || source.startsWith('/') || source.startsWith('~') || /^[A-Za-z]:/.test(source);
}

export function readManifest(): FixtureManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as FixtureManifest;
}

export function writeManifest(manifest: FixtureManifest) {
  manifest.fixtures.sort((a, b) => a.id.localeCompare(b.id));
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function renderNotice(manifest: FixtureManifest) {
  const lines = [
    '# Third-party notices',
    '',
    'The files under `fixtures/` are copied unmodified from the public GitHub repositories listed below, at the',
    'listed commit, under each repository\'s own license. Copyright stays with their authors. Each license applies',
    'to the files from that repository only. This file is generated by `scripts/realworld-fixtures.ts` from',
    '`manifest.json`; do not edit it by hand.',
    '',
  ];
  const byRepo = new Map<string, Array<FixtureEntry>>();
  for (const f of manifest.fixtures) byRepo.set(f.repo, [...(byRepo.get(f.repo) ?? []), f]);
  for (const repo of [...byRepo.keys()].sort((a, b) => a.localeCompare(b))) {
    const entries = byRepo.get(repo)!;
    lines.push(`## ${repo}`, '');
    for (const e of entries) {
      lines.push(`- License: ${e.license.spdx}, https://github.com/${repo}/blob/${e.commit}/${e.license.file}`);
      for (const file of Object.keys(e.files).sort()) {
        lines.push(`  - \`${file}\` at ${e.commit} (fixture \`${e.id}\`)`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function listFilesRecursive(dir: string): Array<string> {
  const out: Array<string> = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

/**
 * Offline integrity check. Returns a list of problems (empty when everything is fine):
 * every frozen file matches its manifest sha256, nothing on disk is missing from the manifest,
 * every entry carries attribution and an allowed license, no file references local plugin code
 * or imports outside its own repo copy, and NOTICE.md matches the manifest.
 */
export function verifyFixtures(opts?: { requireSnapshots?: boolean }): Array<string> {
  const problems: Array<string> = [];
  const fail = (msg: string) => problems.push(msg);
  let manifest: FixtureManifest;
  try {
    manifest = readManifest();
  } catch (err) {
    return [`manifest.json could not be read: ${(err as Error).message}`];
  }
  if (!Array.isArray(manifest.fixtures)) return ['manifest.json: `fixtures` is not an array'];

  const ids = new Set<string>();
  for (const e of manifest.fixtures) {
    const where = e.id ?? '(missing id)';
    if (ids.has(e.id)) fail(`${where}: duplicate id`);
    ids.add(e.id);
    if (!/^[\w.-]+\/[\w.-]+$/.test(e.repo ?? '')) fail(`${where}: repo is not owner/name`);
    if (!/^[0-9a-f]{40}$/.test(e.commit ?? '')) fail(`${where}: commit is not a full sha`);
    if (!isSafeRelativePath(e.path ?? '')) fail(`${where}: path is not a safe repo-relative path`);
    if (e.id !== fixtureId(e.repo, e.path)) fail(`${where}: id does not match repo and path (${fixtureId(e.repo, e.path)})`);
    if (e.url !== `https://github.com/${e.repo}/blob/${e.commit}/${e.path}`) fail(`${where}: url is not the schema at the pinned commit`);
    if (!e.license?.spdx || !(ALLOWED_LICENSES as ReadonlyArray<string>).includes(e.license.spdx)) {
      fail(`${where}: license "${e.license?.spdx}" is not in the allowed list`);
    }
    if (!e.license?.file || !isSafeRelativePath(e.license.file)) fail(`${where}: license file path missing`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.addedAt ?? '')) fail(`${where}: addedAt is not YYYY-MM-DD`);
    if (!Array.isArray(e.plugins) || !Array.isArray(e.unresolved)) fail(`${where}: plugins and unresolved must be arrays`);
    if (e.expectErrors !== undefined && (typeof e.expectErrors !== 'string' || !e.expectErrors.trim())) {
      fail(`${where}: expectErrors must be a non-empty explanation when present`);
    }
    if (!e.files || !e.files[e.path]) fail(`${where}: the schema itself is not in files`);

    const base = path.join(FIXTURES_DIR, e.id);
    const known = new Set<string>();
    for (const [rel, want] of Object.entries(e.files ?? {})) {
      if (!isSafeRelativePath(rel)) {
        fail(`${where}: unsafe file path ${rel}`);
        continue;
      }
      if (!isFreezableFileName(path.posix.basename(rel))) fail(`${where}: ${rel} is not an env-spec file name`);
      known.add(path.join(base, ...rel.split('/')));
      const fp = path.join(base, ...rel.split('/'));
      const st = fs.lstatSync(fp, { throwIfNoEntry: false });
      if (!st) {
        fail(`${where}: missing file ${rel}`);
        continue;
      }
      if (!st.isFile()) {
        fail(`${where}: ${rel} is not a regular file`);
        continue;
      }
      if (st.size > MAX_FILE_BYTES) fail(`${where}: ${rel} is larger than ${MAX_FILE_BYTES} bytes`);
      const buf = fs.readFileSync(fp);
      if (sha256(buf) !== want) fail(`${where}: sha256 mismatch for ${rel}`);
      if (buf.includes(0)) fail(`${where}: ${rel} contains a NUL byte`);
      const text = buf.toString('utf8');
      for (const s of findSecretLookingStrings(text)) fail(`${where}: ${rel} contains a ${s}`);
      for (const p of decoratorFirstArgs(text, 'plugin')) {
        if (isLocalPluginSource(p)) fail(`${where}: ${rel} loads local plugin code (${p})`);
      }
      const dir = path.posix.dirname(rel);
      for (const imp of decoratorFirstArgs(text, 'import')) {
        if (!imp.startsWith('./') && !imp.startsWith('../') && imp !== '.' && imp !== '..') {
          fail(`${where}: ${rel} has a non-relative @import (${imp})`);
          continue;
        }
        if (path.posix.normalize(path.posix.join(dir, imp)).startsWith('..')) {
          fail(`${where}: ${rel} imports outside its own repo copy (${imp})`);
        }
      }
    }
    if (fs.existsSync(base)) {
      for (const fp of listFilesRecursive(base)) {
        if (!known.has(fp)) fail(`${where}: file on disk not in manifest: ${path.relative(base, fp)}`);
      }
    } else {
      fail(`${where}: fixture folder missing`);
    }
    if (opts?.requireSnapshots !== false && !fs.existsSync(path.join(SNAPSHOTS_DIR, `${e.id}.json`))) {
      fail(`${where}: no snapshot`);
    }
  }

  if (fs.existsSync(FIXTURES_DIR)) {
    for (const d of fs.readdirSync(FIXTURES_DIR)) if (!ids.has(d)) fail(`fixtures/${d}: not in manifest`);
  }
  if (fs.existsSync(SNAPSHOTS_DIR)) {
    for (const f of fs.readdirSync(SNAPSHOTS_DIR)) {
      if (!f.endsWith('.json') || !ids.has(f.slice(0, -5))) fail(`snapshots/${f}: no matching fixture`);
    }
  }
  const notice = fs.existsSync(NOTICE_PATH) ? fs.readFileSync(NOTICE_PATH, 'utf8') : '';
  if (notice !== renderNotice(manifest)) fail('NOTICE.md is out of date (run the script\'s `notice` command)');
  return problems;
}
