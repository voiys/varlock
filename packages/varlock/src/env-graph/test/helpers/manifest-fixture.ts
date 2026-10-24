import fs from 'node:fs';
import path from 'node:path';

/** a plugin package that ships a manifest (see its plugin.js) */
export const FIXTURE_DIR = path.join(__dirname, '../plugins/test-plugin-manifest');

/**
 * how many times the fixture plugin's module has run: it counts its own executions in a global, so a
 * test can check whether its code ran
 */
export const pluginRuns = (): number => (globalThis as any).__varlockManifestTestPluginRuns ?? 0;

export type FixtureEdit = { packageJson?: (pkg: any) => void, manifest?: string | ((m: any) => void) };

/** copies the fixture plugin to `dir`, with its package.json and manifest edited, and returns `dir` */
export function copyFixtureTo(dir: string, edit: FixtureEdit = {}) {
  fs.cpSync(FIXTURE_DIR, dir, { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
  edit.packageJson?.(pkg);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  if (typeof edit.manifest === 'string') {
    fs.writeFileSync(path.join(dir, 'plugin-manifest.json'), edit.manifest);
  } else if (edit.manifest) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin-manifest.json'), 'utf-8'));
    edit.manifest(manifest);
    fs.writeFileSync(path.join(dir, 'plugin-manifest.json'), JSON.stringify(manifest));
  }
  return dir;
}
