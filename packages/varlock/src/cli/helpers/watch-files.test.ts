import {
  describe, test, expect, beforeEach, afterEach,
} from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watchFiles, type FileWatchRunner, type WatchRunResult } from './watch-files';

let dir: string;
let watcher: FileWatchRunner | undefined;

beforeEach(() => {
  // realpath: on macOS os.tmpdir() is a symlink and the watcher reports names relative to the directory it was given
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-watch-')));
});

afterEach(() => {
  watcher?.stop();
  watcher = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = (name: string) => path.join(dir, name);
const waitFor = async (check: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await sleep(20);
  }
};

describe('watchFiles', () => {
  test('runs once at start, then once per burst of changes to a reported file', async () => {
    fs.writeFileSync(file('a.env'), '1');
    let runs = 0;
    watcher = watchFiles({
      run: async () => {
        runs++;
        return { files: [file('a.env')], ok: true };
      },
      entryDirs: [dir],
      debounceMs: 50,
    });
    await watcher.idle();
    expect(runs).toBe(1);

    for (let i = 0; i < 5; i++) fs.writeFileSync(file('a.env'), String(i));
    await waitFor(() => runs >= 2);
    await watcher.idle();
    await sleep(200);
    expect(runs).toBe(2);
  });

  test('picks up an atomic save (temp file renamed over the original)', async () => {
    fs.writeFileSync(file('a.env'), '1');
    let runs = 0;
    watcher = watchFiles({
      run: async () => {
        runs++;
        return { files: [file('a.env')], ok: true };
      },
      entryDirs: [dir],
      debounceMs: 50,
    });
    await watcher.idle();
    const runsAtLeast = (n: number) => () => runs >= n;
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(file('a.env.tmp'), String(i));
      fs.renameSync(file('a.env.tmp'), file('a.env'));
      await waitFor(runsAtLeast(i + 2));
      await watcher.idle();
    }
    expect(runs).toBe(4);
  });

  test('ignores unrelated files, but not new .env* files', async () => {
    let runs = 0;
    watcher = watchFiles({
      run: async () => {
        runs++;
        return { files: [], ok: true };
      },
      entryDirs: [dir],
      debounceMs: 50,
    });
    await watcher.idle();
    fs.writeFileSync(file('env.d.ts'), 'x');
    fs.writeFileSync(file('notes.txt'), 'x');
    await sleep(300);
    expect(runs).toBe(1);

    fs.writeFileSync(file('.env.local'), 'x');
    await waitFor(() => runs === 2);
  });

  test('a change during a run schedules exactly one more run, never an overlapping one', async () => {
    fs.writeFileSync(file('a.env'), '1');
    let runs = 0;
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    watcher = watchFiles({
      run: async () => {
        runs++;
        active++;
        maxActive = Math.max(maxActive, active);
        // hold the second run open until the test releases it
        if (runs === 2) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        active--;
        return { files: [file('a.env')], ok: true };
      },
      entryDirs: [dir],
      debounceMs: 30,
    });
    await watcher.idle();
    fs.writeFileSync(file('a.env'), '2');
    await waitFor(() => runs === 2);
    fs.writeFileSync(file('a.env'), '3');
    fs.writeFileSync(file('a.env'), '4');
    await sleep(200);
    expect(runs).toBe(2); // still waiting for the open run
    release();
    await waitFor(() => runs === 3);
    await watcher.idle();
    expect(runs).toBe(3);
    expect(maxActive).toBe(1);
  });

  test('files reported by a failed run are added to the watch set, and earlier ones stay', async () => {
    fs.writeFileSync(file('a.env'), '1');
    fs.writeFileSync(file('b.env'), '1');
    const results: Array<WatchRunResult> = [
      { files: [file('a.env')], ok: true },
      { files: [file('b.env')], ok: false },
    ];
    let runs = 0;
    watcher = watchFiles({
      run: async () => results[Math.min(runs++, results.length - 1)],
      entryDirs: [],
      debounceMs: 30,
    });
    await watcher.idle();
    fs.writeFileSync(file('a.env'), '2');
    await waitFor(() => runs === 2);
    await watcher.idle();
    // a.env dropped out of the failed run's list but is still watched, and so is b.env
    fs.writeFileSync(file('b.env'), '2');
    await waitFor(() => runs === 3);
    await watcher.idle();
    fs.writeFileSync(file('a.env'), '3');
    await waitFor(() => runs === 4);
  });

  test('a run that throws is reported and the watcher keeps going', async () => {
    fs.writeFileSync(file('.env.a'), '1');
    const errors: Array<unknown> = [];
    let runs = 0;
    watcher = watchFiles({
      run: async () => {
        runs++;
        if (runs === 1) throw new Error('boom');
        return { files: [file('.env.a')], ok: true };
      },
      entryDirs: [dir],
      debounceMs: 30,
      onError: (err) => errors.push(err),
    });
    await watcher.idle();
    expect(errors).toHaveLength(1);
    fs.writeFileSync(file('.env.a'), '2');
    await waitFor(() => runs === 2);
  });

  test('stop() ends the watch', async () => {
    fs.writeFileSync(file('a.env'), '1');
    let runs = 0;
    watcher = watchFiles({
      run: async () => {
        runs++;
        return { files: [file('a.env')], ok: true };
      },
      entryDirs: [dir],
      debounceMs: 30,
    });
    await watcher.idle();
    watcher.stop();
    fs.writeFileSync(file('a.env'), '2');
    await sleep(300);
    expect(runs).toBe(1);
  });
});
