import {
  describe, test, expect, vi, beforeEach, afterEach,
} from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
const waitFor = (check: () => boolean) => vi.waitFor(() => {
  if (!check()) throw new Error('timed out waiting for condition');
}, { timeout: 5000, interval: 20 });

/**
 * Start a watcher and wait until it is quiet. macOS reports a few events from just before a watch
 * started, which can cause one extra run right after startup, so tests count runs from this point.
 */
async function startSettled(opts: Parameters<typeof watchFiles>[0], runCount: () => number) {
  watcher = watchFiles(opts);
  await watcher.idle();
  await sleep(400);
  await watcher.idle();
  return runCount();
}

describe('watchFiles', () => {
  test('runs once at start, then once per burst of changes to a reported file', async () => {
    fs.writeFileSync(file('a.env'), '1');
    let runs = 0;
    const base = await startSettled({
      run: async () => {
        runs++;
        return { files: [file('a.env')], ok: true };
      },
      entryDirs: [dir],
      debounceMs: 250,
    }, () => runs);
    expect(base).toBeGreaterThanOrEqual(1);

    for (let i = 0; i < 5; i++) fs.writeFileSync(file('a.env'), String(i));
    await waitFor(() => runs > base);
    await watcher!.idle();
    await sleep(200);
    expect(runs).toBe(base + 1);
  });

  test('picks up an atomic save (temp file renamed over the original)', async () => {
    fs.writeFileSync(file('a.env'), '1');
    let runs = 0;
    const base = await startSettled({
      run: async () => {
        runs++;
        return { files: [file('a.env')], ok: true };
      },
      entryDirs: [dir],
      debounceMs: 50,
    }, () => runs);
    const runsAtLeast = (n: number) => () => runs >= n;
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(file('a.env.tmp'), String(i));
      fs.renameSync(file('a.env.tmp'), file('a.env'));
      await waitFor(runsAtLeast(base + i));
      await watcher!.idle();
    }
    expect(runs).toBeGreaterThanOrEqual(base + 3);
  });

  test('ignores unrelated files, but not new .env* files', async () => {
    let runs = 0;
    const base = await startSettled({
      run: async () => {
        runs++;
        return { files: [], ok: true };
      },
      entryDirs: [dir],
      debounceMs: 50,
    }, () => runs);
    fs.writeFileSync(file('env.d.ts'), 'x');
    fs.writeFileSync(file('notes.txt'), 'x');
    await sleep(300);
    expect(runs).toBe(base);

    fs.writeFileSync(file('.env.local'), 'x');
    await waitFor(() => runs > base);
  });

  test('a change during a run schedules exactly one more run, never an overlapping one', async () => {
    fs.writeFileSync(file('a.env'), '1');
    let runs = 0;
    let active = 0;
    let maxActive = 0;
    let holdRun = 0; // the run number to hold open, 0 for none
    let release!: () => void;
    const base = await startSettled({
      run: async () => {
        runs++;
        active++;
        maxActive = Math.max(maxActive, active);
        if (runs === holdRun) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        active--;
        return { files: [file('a.env')], ok: true };
      },
      entryDirs: [dir],
      debounceMs: 30,
    }, () => runs);

    holdRun = base + 1;
    fs.writeFileSync(file('a.env'), '2');
    await waitFor(() => runs === base + 1);
    fs.writeFileSync(file('a.env'), '3');
    fs.writeFileSync(file('a.env'), '4');
    await sleep(200);
    expect(runs).toBe(base + 1); // still waiting for the open run
    release();
    await waitFor(() => runs === base + 2);
    await watcher!.idle();
    await sleep(200);
    expect(runs).toBe(base + 2);
    expect(maxActive).toBe(1);
  });

  test('files reported by a failed run are added to the watch set, and earlier ones stay', async () => {
    fs.writeFileSync(file('a.env'), '1');
    fs.writeFileSync(file('b.env'), '1');
    let runs = 0;
    let phase: 'first' | 'failed' = 'first';
    const base = await startSettled({
      run: async () => {
        runs++;
        const result: WatchRunResult = phase === 'first'
          ? { files: [file('a.env')], ok: true }
          : { files: [file('b.env')], ok: false };
        return result;
      },
      entryDirs: [],
      debounceMs: 30,
    }, () => runs);

    phase = 'failed';
    fs.writeFileSync(file('a.env'), '2');
    await waitFor(() => runs > base);
    await watcher!.idle();
    // a.env dropped out of the failed run's list but is still watched, and so is b.env
    const afterFailed = runs;
    fs.writeFileSync(file('b.env'), '2');
    await waitFor(() => runs > afterFailed);
    await watcher!.idle();
    const afterB = runs;
    fs.writeFileSync(file('a.env'), '3');
    await waitFor(() => runs > afterB);
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
    const before = runs;
    fs.writeFileSync(file('.env.a'), '2');
    await waitFor(() => runs > before);
  });

  test('an entry file with any name counts from the start, even before the first run finishes', async () => {
    fs.writeFileSync(file('config.env'), '1');
    let runs = 0;
    let release!: () => void;
    watcher = watchFiles({
      run: async () => {
        runs++;
        if (runs === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { files: [], ok: false };
      },
      entryDirs: [dir],
      entryFiles: [file('config.env')],
      debounceMs: 30,
    });
    fs.writeFileSync(file('config.env'), '2');
    await sleep(200);
    release();
    await waitFor(() => runs >= 2);
    await watcher.idle();

    // and after a run that reported nothing, it is still watched
    const before = runs;
    fs.writeFileSync(file('config.env'), '3');
    await waitFor(() => runs > before);
  });

  test.skipIf(process.platform === 'win32')('a FIFO never triggers a run, a regular file next to it does', async () => {
    let runs = 0;
    const base = await startSettled({
      run: async () => {
        runs++;
        return { files: [], ok: true };
      },
      entryDirs: [dir],
      debounceMs: 30,
    }, () => runs);
    execFileSync('mkfifo', [file('.env.pipe')]);
    await sleep(300);
    expect(runs).toBe(base);

    fs.writeFileSync(file('.env.regular'), 'x');
    await waitFor(() => runs > base);
  });

  test('stop() ends the watch', async () => {
    fs.writeFileSync(file('a.env'), '1');
    let runs = 0;
    const base = await startSettled({
      run: async () => {
        runs++;
        return { files: [file('a.env')], ok: true };
      },
      entryDirs: [dir],
      debounceMs: 30,
    }, () => runs);
    watcher!.stop();
    fs.writeFileSync(file('a.env'), '2');
    await sleep(300);
    expect(runs).toBe(base);
  });
});
