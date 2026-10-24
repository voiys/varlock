import {
  describe, test, expect, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import outdent from 'outdent';
import {
  EnvGraph, DotEnvFileDataSource, collectTypeGenItems, generateTsTypesSrc, resolveFieldTypes,
} from '../index';
import { generatePluginManifest } from '../lib/plugins';

// The fixture plugin counts its own module executions in this global, so every test can check
// whether its code ran. Each "it did not run" assertion has a control where it does run.
const FIXTURE_DIR = path.join(__dirname, 'plugins/test-plugin-manifest');
const pluginRuns = () => (globalThis as any).__varlockManifestTestPluginRuns ?? 0;

const schemaFor = (pluginDir: string, items = '') => outdent`
  # @plugin(${pluginDir}/)
  # @initManifestTest(token=$TOKEN)
  # @generateManifestTestFile(path=./manifest-test.txt, flavor=plain)
  # ---
  # @type=manifestTestToken
  TOKEN=
  # @type=manifestTestPort(max=10000)
  PORT=8080
  SECRET=manifestFetch(name)
  # @manifestTag
  TAGGED=x
  ${items}
`;

async function load(schema: string, mode: 'default' | 'shape') {
  const g = new EnvGraph({ mode });
  const source = new DotEnvFileDataSource(path.join(__dirname, '.env.schema'), { overrideContents: schema });
  await g.setRootDataSource(source);
  await g.finishLoad();
  return { g, source };
}

/** everything a tool reads from a loaded graph that a plugin can affect */
async function describeGraph(g: EnvGraph) {
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
      errors: item.errors.map((e) => e.message),
    };
  }
  const plugin = g.plugins[0];
  return {
    items,
    ts: generateTsTypesSrc(resolveFieldTypes(await collectTypeGenItems(g))),
    sourceErrors: g.sortedDataSources.flatMap((s) => s.errors.map((e) => e.message)),
    registries: {
      rootDecorators: Object.keys(g.rootDecoratorsRegistry),
      itemDecorators: Object.keys(g.itemDecoratorsRegistry),
      dataTypes: Object.keys(g.dataTypesRegistry),
      resolvers: Object.keys(g.registeredResolverFunctions),
      codeGenerators: Object.keys(g.codeGeneratorsRegistry),
    },
    resolverDefs: Object.fromEntries(Object.entries(g.registeredResolverFunctions).map(([name, r]) => {
      const { resolve: _resolve, process: _process, ...data } = (r as any).def;
      return [name, data];
    })),
    bundledIcons: g.bundledIcons,
    plugin: {
      name: plugin.name, version: plugin.version, icon: plugin.icon, standardVars: plugin.standardVars,
    },
    shapeSkipped: g.shapeSkipped,
  };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-plugin-manifest-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** a copy of the fixture plugin, with its package.json and manifest edited */
function copyFixture(edit: { packageJson?: (pkg: any) => void, manifest?: string | ((m: any) => void) } = {}) {
  const dir = path.join(tmpDir, 'plugin');
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

describe('plugin manifests', () => {
  test('shape mode registers a plugin from its manifest and never runs its code', async () => {
    const before = pluginRuns();
    const { g, source } = await load(schemaFor(FIXTURE_DIR), 'shape');
    expect(pluginRuns()).toBe(before);
    expect(source.errors.filter((e) => !e.isWarning)).toEqual([]);
    expect(g.plugins.map((p) => [p.name, p.loadedFromManifest])).toEqual([['@varlock/test-plugin-manifest', true]]);
    expect(g.configSchema.TOKEN.dataType?.name).toBe('manifestTestToken');
    expect(g.configSchema.TOKEN.isSensitive).toBe(true);

    // control: default mode ignores the manifest and runs the plugin
    const { g: defaultGraph } = await load(schemaFor(FIXTURE_DIR), 'default');
    expect(pluginRuns()).toBe(before + 1);
    expect(defaultGraph.plugins[0].loadedFromManifest).toBe(false);
  });

  test('gives the same type info as running the plugin', async () => {
    const withoutManifest = copyFixture({ packageJson: (pkg) => delete pkg.exports['./manifest'] });

    const before = pluginRuns();
    const executed = await load(schemaFor(withoutManifest), 'shape');
    // a plugin that ships no manifest still runs in shape mode, as before
    expect(pluginRuns()).toBe(before + 1);
    expect(executed.g.plugins[0].loadedFromManifest).toBe(false);

    const fromManifest = await load(schemaFor(FIXTURE_DIR), 'shape');
    expect(pluginRuns()).toBe(before + 1);
    expect(fromManifest.g.plugins[0].loadedFromManifest).toBe(true);

    const expected = await describeGraph(executed.g);
    expect(expected.items).toHaveProperty('SECRET.isSensitive', true); // impliesSensitive
    expect(expected.items).toHaveProperty('PORT.dataType.coercedType', 'int');
    expect(expected.items).toHaveProperty('TAGGED.isDeprecated', false);
    expect(expected.sourceErrors).toEqual([]);
    expect(await describeGraph(fromManifest.g)).toEqual(expected);
  });

  test('validation and other plugin code is not carried by a manifest', async () => {
    // the plugin's own checks (a data type's validate(), a resolver's process()) only run when it is executed
    const schema = schemaFor(FIXTURE_DIR, 'BAD_TOKEN=nope # @type=manifestTestToken\nDYNAMIC=manifestFetch($PORT)');
    const withoutManifest = copyFixture({ packageJson: (pkg) => delete pkg.exports['./manifest'] });
    const executed = await load(schema.replace(FIXTURE_DIR, withoutManifest), 'shape');
    const fromManifest = await load(schema, 'shape');
    await executed.g.resolveEnvValues();
    await fromManifest.g.resolveEnvValues();
    const errorsOf = ({ g }: { g: EnvGraph }) => Object.fromEntries(
      ['BAD_TOKEN', 'DYNAMIC'].map((key) => [key, g.configSchema[key].errors.filter((e) => !e.isWarning).map((e) => e.message)]),
    );
    expect(errorsOf(executed)).toEqual({ BAD_TOKEN: ['must start with mt_'], DYNAMIC: ['manifestFetch(): expected a static name'] });
    expect(errorsOf(fromManifest)).toEqual({ BAD_TOKEN: [], DYNAMIC: [] });
  });

  test('a value whose type the plugin coerces in code is unknown, and so are values built from it', async () => {
    const schema = schemaFor(FIXTURE_DIR, 'PORT_COPY=$PORT\nPORT_URL=concat("http://localhost:", $PORT)');
    const withoutManifest = copyFixture({ packageJson: (pkg) => delete pkg.exports['./manifest'] });
    const executed = await load(schema.replace(FIXTURE_DIR, withoutManifest), 'shape');
    const fromManifest = await load(schema, 'shape');
    await executed.g.resolveEnvValues();
    await fromManifest.g.resolveEnvValues();
    const valuesOf = ({ g }: { g: EnvGraph }) => Object.fromEntries(['PORT', 'PORT_COPY', 'PORT_URL'].map((key) => [key, { value: g.configSchema[key].resolvedValue, unknown: g.configSchema[key].isValueUnknownInShapeLoad }]));
    // control: running the plugin coerces the port to a number
    expect(valuesOf(executed)).toEqual({
      PORT: { value: 8080, unknown: false },
      PORT_COPY: { value: '8080', unknown: false },
      PORT_URL: { value: 'http://localhost:8080', unknown: false },
    });
    // from the manifest it can't, so it is unknown rather than the string "8080"
    expect(valuesOf(fromManifest)).toEqual({
      PORT: { value: undefined, unknown: true },
      PORT_COPY: { value: undefined, unknown: true },
      PORT_URL: { value: undefined, unknown: true },
    });
    expect(fromManifest.g.shapeSkipped).toContainEqual({ kind: 'coerce', name: 'manifestTestPort', itemKey: 'PORT' });
    // a type the plugin does not coerce keeps its value
    expect(fromManifest.g.configSchema.TAGGED.resolvedValue).toBe('x');
  });

  test('a stub resolver never runs, even if the manifest marks it pure', async () => {
    const dir = copyFixture({
      manifest: (m) => {
        m.resolvers[0].pure = true;
        m.resolvers[0].resolve = 'globalThis.ran = true';
      },
    });
    const { g } = await load(schemaFor(dir), 'shape');
    await g.resolveEnvValues();
    expect(g.plugins[0].loadedFromManifest).toBe(true);
    expect(g.configSchema.SECRET.resolvedValue).toBeUndefined();
    expect(g.shapeSkipped).toContainEqual({ kind: 'resolver', name: 'manifestFetch', itemKey: 'SECRET' });
  });

  test.each([
    ['is not valid JSON', { manifest: '{ nope' }, /could not be read/],
    ['has an unknown manifestVersion', { manifest: (m: any) => { m.manifestVersion = 2; } }, /unsupported manifestVersion 2/],
    ['describes another plugin', { manifest: (m: any) => { m.name = 'other-plugin'; } }, /describes "other-plugin"/],
    ['has a malformed entry', { manifest: (m: any) => { m.resolvers[0].argsSchema = { type: 'nope' }; } }, /unsupported value for "argsSchema"/],
    ['has a malformed coercedType', { manifest: (m: any) => { m.dataTypes[1].coercedType = { recordOf: null }; } }, /unsupported value for "coercedType"/],
    ['has a nested malformed coercedType', { manifest: (m: any) => { m.dataTypes[1].coercedType = { arrayOf: { enum: 'bad' } }; } }, /unsupported value for "coercedType"/],
    ['is outside the package', { packageJson: (pkg: any) => { pkg.exports['./manifest'] = '../outside.json'; } }, /outside its package/],
    ['is missing', { packageJson: (pkg: any) => { pkg.exports['./manifest'] = './missing.json'; } }, /could not be read/],
  ])('a manifest that %s is a schema error, and the plugin does not run', async (_label, edit, message) => {
    const dir = copyFixture(edit as Parameters<typeof copyFixture>[0]);
    const before = pluginRuns();
    const { g, source } = await load(schemaFor(dir), 'shape');
    expect(pluginRuns()).toBe(before);
    expect(g.plugins).toEqual([]);
    expect(source.errors.map((e) => e.message).join('\n')).toMatch(message);
  });

  test('the committed fixture manifest is what generatePluginManifest produces', async () => {
    const committed = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'plugin-manifest.json'), 'utf-8'));
    expect(await generatePluginManifest(FIXTURE_DIR)).toEqual(committed);
  });

  test('generatePluginManifest refuses plugins it cannot describe', async () => {
    const singleFile = path.join(tmpDir, 'single.js');
    fs.writeFileSync(singleFile, "require('varlock/plugin-lib');");
    await expect(generatePluginManifest(singleFile)).rejects.toThrow(/Only plugin packages/);

    const dir = path.join(tmpDir, 'with-regexp');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'with-regexp', exports: { './plugin': './plugin.js' } }));
    fs.writeFileSync(path.join(dir, 'plugin.js'), outdent`
      const { plugin } = require('varlock/plugin-lib');
      plugin.registerResolverFunction({ name: 'rx', inferredTypeSettings: { matches: /x/ }, resolve: () => 'x' });
    `);
    await expect(generatePluginManifest(dir)).rejects.toThrow(/resolver "rx": unsupported value for "inferredTypeSettings"/);
  });
});
