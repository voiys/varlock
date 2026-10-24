/**
 * Loads every frozen real-world schema in `fixtures/` with `EnvGraph` in shape mode and compares
 * what varlock sees (item keys, types, required and sensitive flags, errors) with the committed
 * snapshot in `snapshots/`.
 *
 * The fixtures are untrusted input. They are only ever loaded in shape mode, which never runs
 * exec(), root decorators or secret providers and never downloads plugins. On top of that, this
 * file replaces child_process, http and https with versions that record and refuse every call,
 * and fetch with a spy that does the same, and every test asserts nothing was attempted. No
 * plugin is installed where these fixtures can find one, so `@plugin(...)` lines end in an
 * expected "unable to resolve" error and no plugin code is imported.
 *
 * Snapshots only change when asked: REALWORLD_SCHEMAS_UPDATE=1 bunx vitest run test/realworld-schemas
 * See README.md in this folder for how to add fixtures.
 */

import {
  afterAll, beforeAll, describe, expect, test, vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import outdent from 'outdent';

import { EnvGraph, DotEnvFileDataSource, FileBasedDataSource } from '../../src/env-graph';
import {
  FIXTURES_DIR, SNAPSHOTS_DIR, readManifest, sha256, verifyFixtures, type FixtureEntry,
} from './fixture-manifest';

const { attempts, blockedModule } = vi.hoisted(() => {
  const attemptList: Array<string> = [];
  // a copy of a node module whose listed functions record the call and throw instead of running
  const blockedModuleFn = (actual: Record<string, unknown>, label: string, names: Array<string>) => {
    const blocked: Record<string, unknown> = {};
    for (const name of names) {
      blocked[name] = (...callArgs: Array<unknown>) => {
        attemptList.push(`${label}.${name} ${String(callArgs[0]).slice(0, 80)}`);
        throw new Error(`${label}.${name} is blocked in the real-world schema tests`);
      };
    }
    return { ...actual, ...blocked, default: { ...(actual.default as object), ...blocked } };
  };
  return { attempts: attemptList, blockedModule: blockedModuleFn };
});

vi.mock('node:child_process', async (importOriginal) => blockedModule(
  await importOriginal<Record<string, unknown>>(),
  'child_process',
  ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync'],
));
vi.mock('node:http', async (importOriginal) => blockedModule(await importOriginal<Record<string, unknown>>(), 'http', ['request', 'get']));
vi.mock('node:https', async (importOriginal) => blockedModule(await importOriginal<Record<string, unknown>>(), 'https', ['request', 'get']));

const UPDATE = process.env.REALWORLD_SCHEMAS_UPDATE === '1';
const manifest = readManifest();

let prevXdg: string | undefined;
let tmpConfigDir: string;
beforeAll(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    attempts.push(`fetch ${String(input).slice(0, 80)}`);
    throw new Error('network is blocked in the real-world schema tests');
  });
  // an empty varlock config dir, so a pinned plugin is never found in the maintainer's own plugin cache
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-realworld-'));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpConfigDir;
});
afterAll(() => {
  vi.restoreAllMocks();
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
});

type Snapshot = {
  id: string,
  items: Array<{ key: string, type: string, required: boolean | 'dynamic', sensitive: boolean }>,
  errors: Array<{ at: string, message: string, warning?: true }>,
  shapeSkipped: Array<string>,
};

async function loadFixture(entry: FixtureEntry) {
  const fixtureDir = path.join(FIXTURES_DIR, entry.id);
  const schemaPath = path.join(fixtureDir, ...entry.path.split('/'));
  const g = new EnvGraph({ mode: 'shape' });
  expect(g.mode).toBe('shape');
  g.basePath = path.dirname(schemaPath);
  const errors: Snapshot['errors'] = [];
  // messages can carry absolute paths; keep snapshots machine independent
  const clean = (msg: string) => msg.split(fixtureDir).join('<fixture>').split(os.tmpdir()).join('<tmp>');
  const pushErr = (at: string, e: { message: string, isWarning?: boolean }) => {
    errors.push({ at, message: clean(String(e.message)), ...e.isWarning ? { warning: true as const } : {} });
  };
  try {
    await g.setRootDataSource(new DotEnvFileDataSource(schemaPath));
    await g.finishLoad();
  } catch (err) {
    pushErr('load', err as Error);
  }

  const sourcePaths: Array<string> = [];
  for (const source of g.sortedDataSources) {
    const where = source instanceof FileBasedDataSource
      ? path.relative(fixtureDir, source.fullPath).split(path.sep).join('/')
      : source.label;
    if (source instanceof FileBasedDataSource) sourcePaths.push(source.fullPath);
    for (const e of source.errors) pushErr(`source ${where}`, e);
  }
  const items: Snapshot['items'] = [];
  for (const key of g.sortedConfigKeys) {
    const item = g.configSchema[key];
    items.push({
      key,
      type: item.dataType?.name ?? 'string',
      required: item.isRequiredDynamic ? 'dynamic' : item.isRequired,
      sensitive: item.isSensitive,
    });
    for (const e of item.errors) pushErr(`item ${key}`, e);
  }
  const snapshot: Snapshot = {
    id: entry.id,
    items,
    errors,
    shapeSkipped: g.shapeSkipped.map((s) => `${s.kind}:${s.name}${s.itemKey ? ` (${s.itemKey})` : ''}`),
  };
  return {
    g, snapshot, fixtureDir, sourcePaths,
  };
}

describe('real-world schema fixtures', () => {
  test('fixtures match the manifest (offline integrity check)', () => {
    expect(verifyFixtures({ requireSnapshots: !UPDATE })).toEqual([]);
    expect(manifest.fixtures.length).toBeGreaterThan(0);
  });

  // Positive controls: the same guards catch varlock itself trying to spawn or fetch, so a clean
  // run below means nothing was attempted, not that the guards never fire.
  test('control: default mode exec() is caught by the child_process guard', async () => {
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource(path.join(os.tmpdir(), '.env.schema'), {
      overrideContents: outdent`
        # ---
        TOKEN=exec(\`echo hi\`)
      `,
    }));
    await g.finishLoad();
    await g.resolveEnvValues();
    expect(attempts.some((a) => a.startsWith('child_process.'))).toBe(true);
    attempts.length = 0;
  });

  test('control: default mode plugin download is caught by the fetch guard', async () => {
    const g = new EnvGraph();
    await g.setRootDataSource(new DotEnvFileDataSource(path.join(os.tmpdir(), '.env.schema'), {
      overrideContents: outdent`
        # @plugin(@varlock/realworld-fixture-control-plugin@9.9.9)
        # ---
        A=1
      `,
    }));
    await g.finishLoad();
    expect(attempts.some((a) => a.startsWith('fetch ') || a.startsWith('https.'))).toBe(true);
    attempts.length = 0;
  });

  for (const entry of manifest.fixtures) {
    test(entry.id, async () => {
      // never load a file that differs from what was reviewed
      for (const [rel, want] of Object.entries(entry.files)) {
        expect(sha256(fs.readFileSync(path.join(FIXTURES_DIR, entry.id, ...rel.split('/')))), rel).toBe(want);
      }

      attempts.length = 0;
      const {
        g, snapshot, fixtureDir, sourcePaths,
      } = await loadFixture(entry);

      expect(attempts).toEqual([]);
      expect(g.plugins).toEqual([]); // no plugin code was imported
      for (const p of sourcePaths) expect(p.startsWith(fixtureDir + path.sep), p).toBe(true);

      const snapshotPath = path.join(SNAPSHOTS_DIR, `${entry.id}.json`);
      if (UPDATE) {
        fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
        fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
      } else if (!fs.existsSync(snapshotPath)) {
        throw new Error(`no snapshot for ${entry.id}; create it with REALWORLD_SCHEMAS_UPDATE=1 and review it`);
      }

      // every error (warnings aside) is explained in the manifest, and a fixture without errors carries no explanation
      expect(Boolean(entry.expectErrors), 'manifest expectErrors must be set exactly when there are errors')
        .toBe(snapshot.errors.some((e) => !e.warning));

      expect(snapshot).toEqual(JSON.parse(fs.readFileSync(snapshotPath, 'utf8')));
    });
  }
});
