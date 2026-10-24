import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  describe, test, expect, afterAll,
} from 'vitest';
import outdent from 'outdent';
import { internal } from 'varlock';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.join(__dirname, '..');
const PLUGIN_ENTRY = path.join(PLUGIN_PATH, 'dist', 'plugin.cjs');

// everything the plugin can add to a schema: both init forms, two instances, op() with an instance
// id and allowMissing, opLoadEnvironment through @setValuesBulk, and both token data types (one
// with a value its validationRules reject)
const schemaFor = (pluginDir: string) => outdent`
  # @currentEnv=$APP_ENV
  # @defaultRequired=false @defaultSensitive=false
  # @plugin(${pluginDir}/)
  # @initOp(token=$OP_TOKEN, allowAppAuth=true, account=acme)
  # @initOp(id=ci, connectHost="http://connect:8080", connectToken=$OP_CONNECT_TOKEN, allowMissing=forEnv(development))
  # @setValuesBulk(opLoadEnvironment("env_abc123"), format=json)
  # ---
  # @type=enum(development, production)
  APP_ENV=development
  # @type=opServiceAccountToken
  OP_TOKEN=
  # @type=opConnectToken
  OP_CONNECT_TOKEN=
  # @type=opServiceAccountToken
  BAD_OP_TOKEN=not-a-token
  DB_PASSWORD=op("op://Dev/db/password")
  API_KEY=op(ci, "op://Dev/api/key", allowMissing=true)
  # @sensitive
  WITH_FALLBACK=fallback(op("op://Dev/x/y", allowMissing=true), "local-dev-key")
  OTP_CODE=op("op://Dev/gh/one-time password?attribute=otp")
`;

async function loadShape(pluginDir: string) {
  const g = new internal.EnvGraph({ mode: 'shape' });
  const source = new internal.DotEnvFileDataSource(path.join(pluginDir, '.env.schema'), { overrideContents: schemaFor(pluginDir) });
  await g.setRootDataSource(source);
  await g.finishLoad();
  await g.resolveEnvValues();
  return g;
}

async function describeGraph(g: InstanceType<typeof internal.EnvGraph>) {
  const items: Record<string, unknown> = {};
  for (const key of g.sortedConfigKeys) {
    const item = g.configSchema[key];
    const { dataType, ...info } = await item.getTypeGenInfo();
    items[key] = {
      ...info,
      dataType: dataType && {
        name: dataType.name, icon: dataType.icon, coercedType: dataType.coercedType, docs: dataType.docsEntries,
      },
      isInternal: item.isInternal,
      resolvedValue: item.resolvedValue,
      errors: item.errors.map((e) => e.message),
    };
  }
  return {
    items,
    sourceErrors: g.sortedDataSources.flatMap((s) => s.errors.map((e) => e.message)),
    registries: [
      Object.keys(g.rootDecoratorsRegistry),
      Object.keys(g.itemDecoratorsRegistry),
      Object.keys(g.dataTypesRegistry),
      Object.keys(g.registeredResolverFunctions),
      Object.keys(g.codeGeneratorsRegistry),
    ],
    bundledIcons: g.bundledIcons,
    plugins: g.plugins.map((p) => ({
      name: p.name, version: p.version, icon: p.icon, standardVars: p.standardVars,
    })),
    shapeSkipped: g.shapeSkipped,
  };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-1password-manifest-'));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('1password plugin manifest', () => {
  test('shape mode gets the same type info from the manifest as from running the plugin', async () => {
    const pluginCache = createRequire(import.meta.url).cache;
    const fromManifest = await loadShape(PLUGIN_PATH);
    expect(fromManifest.plugins[0].loadedFromManifest).toBe(true);
    // the plugin bundle was never loaded
    expect(pluginCache[fs.realpathSync(PLUGIN_ENTRY)]).toBeUndefined();

    // the same built plugin without the manifest export runs as before
    const withoutManifest = path.join(tmpDir, 'plugin');
    fs.cpSync(path.join(PLUGIN_PATH, 'dist'), path.join(withoutManifest, 'dist'), { recursive: true });
    const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_PATH, 'package.json'), 'utf-8'));
    delete pkg.exports['./manifest'];
    fs.writeFileSync(path.join(withoutManifest, 'package.json'), JSON.stringify(pkg));
    const executed = await loadShape(withoutManifest);
    expect(executed.plugins[0].loadedFromManifest).toBe(false);
    expect(pluginCache[fs.realpathSync(path.join(withoutManifest, 'dist', 'plugin.cjs'))]).toBeDefined();

    const expected = await describeGraph(executed);
    expect(expected.sourceErrors).toEqual([]);
    expect(expected.items).toHaveProperty('OP_TOKEN.dataType.name', 'opServiceAccountToken');
    expect(expected.items).toHaveProperty('OP_TOKEN.isInternal', true);
    expect(expected.items).toHaveProperty('BAD_OP_TOKEN.errors', ['Service account tokens must start with ops_']);
    expect(expected.registries[3]).toEqual(expect.arrayContaining(['op', 'opLoadEnvironment']));
    expect(await describeGraph(fromManifest)).toEqual(expected);
  });
});
