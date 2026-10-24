/**
 * Generates the manifest a plugin package ships (the file its package.json `exports["./manifest"]`
 * points at). Shape mode reads it to learn the plugin's decorators, data types and resolvers
 * without running the plugin. The manifest is generated from the built plugin, so it never has to
 * be edited by hand, and `--check` keeps the committed copy in sync with the plugin code.
 *
 * With no directories given, it handles every package in packages/plugins, and each one must
 * have a `./manifest` export. This runs each plugin's code, so build first. Generating a manifest
 * also checks that each data type's `validationRules` agree with its `validate()`.
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

function hasManifestExport(pluginDir: string): boolean {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf-8'));
  return pkgJson.exports?.['./manifest'] !== undefined;
}

const problems: Array<string> = [];
let pluginDirs = explicitDirs;
if (!explicitDirs.length) {
  pluginDirs = fs.readdirSync(PLUGINS_DIR).sort().map((d) => path.join(PLUGINS_DIR, d))
    .filter((d) => fs.existsSync(path.join(d, 'package.json')));
  // every first-party plugin ships a manifest, so shape mode never has to run one
  for (const dir of pluginDirs.filter((d) => !hasManifestExport(d))) {
    problems.push(`${path.relative(MONOREPO_ROOT, dir)}: no "./manifest" export in package.json (add "./manifest": "./plugin-manifest.json" and list the file in "files")`);
  }
  pluginDirs = pluginDirs.filter(hasManifestExport);
}

if (!fs.existsSync(VARLOCK_DIST)) {
  console.error('varlock is not built: run `bun run build:libs` first');
  process.exit(1);
}
const { internal } = await import(pathToFileURL(VARLOCK_DIST).href);

for (const pluginDir of pluginDirs) {
  const relDir = path.relative(MONOREPO_ROOT, pluginDir);
  let contents: string;
  let manifestPath: string;
  try {
    // resolves the "./manifest" export the same way varlock does when loading it
    const generated = await internal.generatePluginManifest(pluginDir);
    contents = `${JSON.stringify(generated.manifest, null, 2)}\n`;
    manifestPath = generated.manifestPath;
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
