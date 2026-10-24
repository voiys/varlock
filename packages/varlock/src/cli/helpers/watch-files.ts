import path from 'node:path';
import { watch as fsWatch, type FSWatcher } from 'node:fs';

export type WatchRunResult = {
  /** absolute paths of the files the last run read, so edits to any of them trigger another run */
  files: Array<string>,
  /**
   * Whether the run succeeded. After a failed run the previously watched files stay watched, so a
   * file that dropped out of a half-typed schema (an `@import` that no longer parses) is still
   * watched and fixing it triggers a retry.
   */
  ok: boolean,
};

export type FileWatchRunner = {
  /** stop watching. Safe to call more than once; a run already in flight finishes */
  stop: () => void,
  /** resolves when no run is in flight or scheduled */
  idle: () => Promise<void>,
};

/**
 * Re-run `run` whenever one of the files it reported changes, debounced and never overlapping
 * (a change during a run schedules exactly one more run afterwards).
 *
 * Directories are watched rather than files, because editors save by renaming a temp file into
 * place, which silently ends a watch on the file itself. A directory event counts when it names
 * a known file, or any `.env*` file (so a newly created `.env.schema` or `.env.local` is picked
 * up in a directory source). `entryDirs` are watched from the start, including before the first
 * run has reported any files.
 *
 * `run` should handle its own errors and report them through `ok: false`. If it throws anyway, the
 * error goes to `onError` and the watcher keeps going.
 */
export function watchFiles(opts: {
  run: () => Promise<WatchRunResult>,
  entryDirs: Array<string>,
  debounceMs?: number,
  onError?: (err: unknown) => void,
}): FileWatchRunner {
  const debounceMs = opts.debounceMs ?? 150;
  let stopped = false;
  let knownFiles = new Set<string>();
  const watchers = new Map<string, FSWatcher>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let rerun = false;
  let idleWaiters: Array<() => void> = [];
  // set below, once the run loop exists: the directory watchers and the run loop need each other
  const hooks: { onChange?: () => void } = {};

  const closeWatcher = (dir: string) => {
    watchers.get(dir)?.close();
    watchers.delete(dir);
  };

  const addWatcher = (dir: string) => {
    try {
      const watcher = fsWatch(dir, { persistent: true }, (_event, name) => {
        // some platforms omit the filename: treat that as "something changed"
        if (name && !knownFiles.has(path.join(dir, name)) && !name.startsWith('.env')) return;
        hooks.onChange?.();
      });
      // a watched directory that gets deleted emits an error: drop it, and the next run re-adds it
      watcher.on('error', () => closeWatcher(dir));
      watchers.set(dir, watcher);
    } catch {
      // not watchable here (missing, or the platform refuses): the other directories still work
    }
  };

  const syncWatchers = () => {
    if (stopped) return;
    const wanted = new Set(opts.entryDirs.map((d) => path.resolve(d)));
    for (const file of knownFiles) wanted.add(path.dirname(file));
    for (const dir of [...watchers.keys()]) {
      if (!wanted.has(dir)) closeWatcher(dir);
    }
    for (const dir of wanted) {
      if (!watchers.has(dir)) addWatcher(dir);
    }
  };

  const loop = async () => {
    running = true;
    try {
      do {
        rerun = false;
        try {
          const result = await opts.run();
          const files = result.files.map((f) => path.resolve(f));
          knownFiles = result.ok ? new Set(files) : new Set([...knownFiles, ...files]);
        } catch (err) {
          opts.onError?.(err);
        }
        syncWatchers();
      } while (rerun && !stopped);
    } finally {
      running = false;
      const waiters = idleWaiters;
      idleWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  };

  const startLoop = () => {
    loop().catch((err) => opts.onError?.(err));
  };

  hooks.onChange = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (running) rerun = true;
      else startLoop();
    }, debounceMs);
  };

  // first run starts right away, and the entry directories are watched while it runs so an edit
  // made during startup is not missed
  syncWatchers();
  startLoop();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      for (const dir of [...watchers.keys()]) closeWatcher(dir);
    },
    idle() {
      if (!running && !timer) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
  };
}
