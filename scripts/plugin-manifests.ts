/**
 * Generates the manifest a plugin package ships (the file its package.json `exports["./manifest"]`
 * points at). Shape mode reads it to learn the plugin's decorators, data types and resolvers
 * without running the plugin. The manifest is generated from the built plugin, so it never has to
 * be edited by hand, and `--check` keeps the committed copy in sync with the plugin code.
 *
 * With no directories given, it handles every package in packages/plugins that has a
 * `./manifest` export. This runs each plugin's code, so build first.
 *
 * Usage (after building):
 *   bun run plugin-manifests                 # regenerate committed manifests
 *   bun run plugin-manifests --check         # exit 1 if a committed manifest is out of date
 *   bun run plugin-manifests [--check] <dir> # a specific plugin package
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MONOREPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS_DIR = path.join(MONOREPO_ROOT, 'packages/plugins');
const VARLOCK_DIST = path.join(MONOREPO_ROOT, 'packages/varlock/dist/index.mjs');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const explicitDirs = args.filter((a) => !a.startsWith('--')).map((d) => path.resolve(d));

function readManifestExport(pluginDir: string): string | undefined {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf-8'));
  const manifestExport = pkgJson.exports?.['./manifest'];
  return typeof manifestExport === 'string' ? path.join(pluginDir, manifestExport) : undefined;
}

const pluginDirs = explicitDirs.length
  ? explicitDirs
  : fs.readdirSync(PLUGINS_DIR).sort().map((d) => path.join(PLUGINS_DIR, d))
    .filter((d) => fs.existsSync(path.join(d, 'package.json')) && readManifestExport(d));

if (!fs.existsSync(VARLOCK_DIST)) {
  console.error('varlock is not built: run `bun run build:libs` first');
  process.exit(1);
}
const { internal } = await import(pathToFileURL(VARLOCK_DIST).href);

const problems: Array<string> = [];
for (const pluginDir of pluginDirs) {
  const relDir = path.relative(MONOREPO_ROOT, pluginDir);
  const manifestPath = readManifestExport(pluginDir);
  if (!manifestPath) {
    problems.push(`${relDir}: package.json has no "./manifest" export`);
    continue;
  }
  let contents: string;
  try {
    contents = `${JSON.stringify(await internal.generatePluginManifest(pluginDir), null, 2)}\n`;
  } catch (err) {
    problems.push(`${relDir}: ${(err as Error).message}`);
    continue;
  }
  const current = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf-8') : undefined;
  const relManifest = path.relative(MONOREPO_ROOT, manifestPath);
  if (current === contents) {
    console.log(`${relManifest} is up to date`);
  } else if (checkOnly) {
    problems.push(`${relManifest} is out of date`);
  } else {
    fs.writeFileSync(manifestPath, contents);
    console.log(`wrote ${relManifest}`);
  }
}

if (problems.length) {
  console.error('Plugin manifest check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  if (checkOnly) console.error('\nRun `bun run plugin-manifests` after building, and commit the result.');
  process.exit(1);
}
