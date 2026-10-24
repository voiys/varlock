import {
  describe, test, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import outdent from 'outdent';
import { startCodegenWatch } from '../codegen.command';
import type { FileWatchRunner } from '../../helpers/watch-files';

// `varlock codegen --watch` against real files in a temp dir.

let dir: string;
let watcher: FileWatchRunner | undefined;
let logs: Array<string>;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-codegen-watch-')));
  logs = [];
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  watcher?.stop();
  watcher = undefined;
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = (name: string) => path.join(dir, name);
const write = (name: string, contents: string) => fs.writeFileSync(file(name), contents);
const output = () => (fs.existsSync(file('env.d.ts')) ? fs.readFileSync(file('env.d.ts'), 'utf-8') : '');
const waitFor = async (check: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for condition. output so far:\n${output()}\nlogs: ${logs.join(' | ')}`);
    await sleep(20);
  }
};
const start = async (entry = dir) => {
  watcher = startCodegenWatch({ entryFilePaths: [entry], debounceMs: 50, log: (msg) => logs.push(msg) });
  await watcher.idle();
};

const SCHEMA = (items: string) => outdent`
  # @generateTsTypes(path=env.d.ts)
  # ---
  ${items}
`;

describe('codegen --watch', () => {
  test('generates at start and regenerates when the schema changes', async () => {
    write('.env.schema', SCHEMA('A=a'));
    await start();
    expect(output()).toContain('A: string');
    expect(output()).not.toContain('B:');

    write('.env.schema', SCHEMA('A=a\nB=b'));
    await waitFor(() => output().includes('B: string'));
  });

  test('regenerates when an imported file changes, including one in another directory', async () => {
    fs.mkdirSync(file('shared'));
    write('.env.schema', outdent`
      # @generateTsTypes(path=env.d.ts)
      # @import(./.env.shared)
      # @import(./shared/.env.two)
      # ---
      A=a
    `);
    write('.env.shared', 'SHARED_ONE=1\n');
    write('shared/.env.two', 'SHARED_TWO=1\n');
    await start();
    expect(output()).toContain('SHARED_ONE');
    expect(output()).toContain('SHARED_TWO');

    write('.env.shared', 'SHARED_ONE=1\nSHARED_ONE_B=1\n');
    await waitFor(() => output().includes('SHARED_ONE_B'));
    write('shared/.env.two', 'SHARED_TWO=1\nSHARED_TWO_B=1\n');
    await waitFor(() => output().includes('SHARED_TWO_B'));
  });

  test('watches a schema that is saved by renaming a temp file over it', async () => {
    write('.env.schema', SCHEMA('A=a'));
    await start();
    for (const key of ['B', 'C']) {
      const current = fs.readFileSync(file('.env.schema'), 'utf-8');
      write('.env.schema.tmp', `${current}\n${key}=x\n`);
      fs.renameSync(file('.env.schema.tmp'), file('.env.schema'));
      await waitFor(() => output().includes(`${key}: string`));
    }
  });

  test('a half-typed schema keeps the last good output, and the next valid save recovers', async () => {
    write('.env.schema', SCHEMA('A=a'));
    await start();
    const good = output();
    expect(good).toContain('A: string');

    write('.env.schema', SCHEMA('A=a\n# @required=\nB=b'));
    await waitFor(() => logs.some((l) => l.includes('Generated files were not changed')));
    expect(output()).toBe(good);

    // still watching: a later broken save is reported too, and fixing it regenerates
    write('.env.schema', SCHEMA('A=a\n# @\nB=b'));
    await waitFor(() => logs.filter((l) => l.includes('Generated files were not changed')).length === 2);
    expect(output()).toBe(good);

    write('.env.schema', SCHEMA('A=a\nB=b'));
    await waitFor(() => output().includes('B: string'));
  });

  test('an import that stops parsing is still watched, so fixing it recovers', async () => {
    write('.env.schema', outdent`
      # @generateTsTypes(path=env.d.ts)
      # @import(./.env.shared)
      # ---
      A=a
    `);
    write('.env.shared', 'S=1\n');
    await start();
    expect(output()).toContain('S: ');

    write('.env.shared', '# @required=\nS=1\nS2=1\n');
    await waitFor(() => logs.some((l) => l.includes('Generated files were not changed')));
    expect(output()).not.toContain('S2');

    write('.env.shared', 'S=1\nS2=1\n');
    await waitFor(() => output().includes('S2'));
  });

  test('starts from a schema that does not load yet and generates once it does', async () => {
    write('.env.schema', '# @required=\nA=a\n');
    await start();
    expect(output()).toBe('');
    write('.env.schema', SCHEMA('A=a'));
    await waitFor(() => output().includes('A: string'));
  });

  test('a new schema file in a directory with none is picked up', async () => {
    await start();
    expect(output()).toBe('');
    write('.env.schema', SCHEMA('A=a'));
    await waitFor(() => output().includes('A: string'));
  });

  test('a missing code-generation decorator is reported and the watch continues', async () => {
    write('.env.schema', '# ---\nA=a\n');
    await start();
    expect(logs.some((l) => l.includes('Generated files were not changed'))).toBe(true);
    write('.env.schema', SCHEMA('A=a'));
    await waitFor(() => output().includes('A: string'));
  });

  test('never runs schema commands, on the first run or on later ones', async () => {
    const markers = ['CACHE', 'BULK', 'ITEM'].map((n) => file(`MARKER_${n}`));
    const touchCmd = (marker: string, out: string) => {
      const m = marker.replace(/\\/g, '/');
      return `node -e "require('fs').writeFileSync('${m}', ''); process.stdout.write('${out}')"`;
    };
    const schema = (extra: string) => outdent`
      # @cache=exec(\`${touchCmd(markers[0], 'memory')}\`)
      # @setValuesBulk(exec(\`${touchCmd(markers[1], 'A=1')}\`))
      # @generateTsTypes(path=env.d.ts)
      # ---
      A=
      TOKEN=exec(\`${touchCmd(markers[2], 'x')}\`)
      ${extra}
    `;
    write('.env.schema', schema(''));
    await start();
    expect(output()).toContain('TOKEN: string');
    write('.env.schema', schema('B=b'));
    await waitFor(() => output().includes('B: string'));
    for (const marker of markers) expect(fs.existsSync(marker)).toBe(false);
  });

  test('stop() ends the watch', async () => {
    write('.env.schema', SCHEMA('A=a'));
    await start();
    watcher!.stop();
    write('.env.schema', SCHEMA('A=a\nB=b'));
    await sleep(400);
    expect(output()).not.toContain('B: string');
  });
});
