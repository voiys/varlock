import fs from 'node:fs';
import path from 'node:path';
import ansis from 'ansis';
import { FileBasedDataSource, DirectoryDataSource, type EnvGraph } from '../../env-graph';
import { loadVarlockEnvGraph } from '../../lib/load-graph';
import { checkForNoEnvFiles, checkForSchemaErrors } from '../helpers/error-checks';
import { CliExitError } from '../helpers/exit-error';
import { type TypedGunshiCommandFn } from '../helpers/gunshi-type-utils';
import { watchFiles, type FileWatchRunner, type WatchRunResult } from '../helpers/watch-files';
import { commandSpec } from './codegen.command-spec';

export { commandSpec };

/** Load the schema, check it, and write every generated file. Throws a `CliExitError` when it can't. */
async function generateFromGraph(envGraph: EnvGraph) {
  checkForSchemaErrors(envGraph);
  checkForNoEnvFiles(envGraph);

  // Force generation even if auto=false is set
  const { generatedCount, skippedImportOnlyCount } = await envGraph.runCodeGeneratorsIfNeeded({
    ignoreAutoFalse: true,
  });

  if (generatedCount === 0) {
    // decorators may exist but only in @import-ed files — that's a different fix than "add one"
    if (skippedImportOnlyCount > 0) {
      throw new CliExitError('Code-generation decorators were found only in imported files, which are skipped by default', {
        suggestion: 'Add `executeWhenImported=true` to the decorator in the imported file, or add a decorator to this schema directly.',
      });
    }
    throw new CliExitError('No code-generation decorator found in your schema', {
      suggestion: 'Add `@generateTsTypes(path=env.d.ts)` (or `@generatePythonEnv(path=env.py)`, etc.) to your .env.schema file.',
    });
  }
}

/** Nudge about keys that only live in a plain `.env` and were left out of the generated output. */
function logExcludedKeys(envGraph: EnvGraph) {
  // Only shown here (the explicit command), not during background auto-generation on load/run.
  const excludedKeys = envGraph.getValueOnlyKeysExcludedFromTypes();
  if (excludedKeys.length) {
    console.log('');
    console.log(`ℹ️  Ignored ${excludedKeys.length} key${excludedKeys.length === 1 ? '' : 's'} found only in .env (not declared in your schema):`);
    console.log(`   ${excludedKeys.join(', ')}`);
    console.log('   Declare them in your .env.schema to include them in generated output.');
  }
}

/** Files (and directory sources) the graph read, so a watcher knows what to watch. */
function getLoadedPaths(envGraph: EnvGraph) {
  const files: Array<string> = [];
  for (const source of envGraph.sortedDataSources) {
    if (source instanceof FileBasedDataSource) files.push(source.fullPath);
    // a directory source also picks up files that are created later
    else if (source instanceof DirectoryDataSource) files.push(path.join(source.basePath, '.env'));
  }
  return files;
}

function reportError(err: unknown) {
  if (err instanceof CliExitError) {
    const out = err.getFormattedOutput();
    if (out) console.error(out);
  } else {
    console.error(ansis.red(`- ❌ ${err instanceof Error ? err.message : String(err)}`));
  }
}

/**
 * `varlock codegen --watch`: regenerate whenever the schema or a file it imports changes. Always loads
 * in shape mode, because it runs on every save and must never execute schema commands or reach
 * a secret store. A schema that does not load (a half-typed edit) is reported and the generated files
 * are left as they were, then the watcher keeps going.
 */
export function startCodegenWatch(opts: {
  entryFilePaths?: Array<string>,
  debounceMs?: number,
  log?: (msg: string) => void,
}): FileWatchRunner {
  const log = opts.log ?? console.log;
  const entryDirs = (opts.entryFilePaths?.length ? opts.entryFilePaths : [process.cwd()]).map((p) => {
    const resolved = path.resolve(p);
    return fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? path.dirname(resolved) : resolved;
  });

  let isFirstRun = true;
  const run = async (): Promise<WatchRunResult> => {
    const firstRun = isFirstRun;
    isFirstRun = false;
    let envGraph: EnvGraph;
    try {
      envGraph = await loadVarlockEnvGraph({ entryFilePaths: opts.entryFilePaths, mode: 'shape' });
    } catch (err) {
      reportError(err);
      log(ansis.yellow('Generated files were not changed. Waiting for the next change...'));
      return { files: [], ok: false };
    }
    const files = getLoadedPaths(envGraph);
    try {
      await generateFromGraph(envGraph);
    } catch (err) {
      reportError(err);
      log(ansis.yellow('Generated files were not changed. Waiting for the next change...'));
      return { files, ok: false };
    }
    log('✅ Code generated successfully');
    if (firstRun) logExcludedKeys(envGraph);
    return { files, ok: true };
  };

  return watchFiles({ run, entryDirs, debounceMs: opts.debounceMs });
}

export const commandFn: TypedGunshiCommandFn<typeof commandSpec> = async (ctx) => {
  if (ctx.values.watch) {
    for (const p of ctx.values.path ?? []) {
      if (!fs.existsSync(path.resolve(p))) {
        throw new CliExitError(`The --path value does not exist: ${path.resolve(p)}`, {
          suggestion: 'Use `--path` to specify a valid file or directory.',
        });
      }
    }
    const watcher = startCodegenWatch({ entryFilePaths: ctx.values.path });
    await watcher.idle();
    console.log(ansis.dim('Watching for changes. Press Ctrl+C to stop.'));
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        watcher.stop();
        resolve();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
    return;
  }

  const envGraph = await loadVarlockEnvGraph({
    entryFilePaths: ctx.values.path,
    mode: ctx.values.shape ? 'shape' : 'default',
  });
  await generateFromGraph(envGraph);

  console.log('✅ Code generated successfully');
  logExcludedKeys(envGraph);
};
