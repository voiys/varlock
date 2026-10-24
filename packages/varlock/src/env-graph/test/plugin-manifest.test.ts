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
import { checkDataTypeValidationRules } from '../lib/plugin-manifest';
import { checkValidationRules, findValidationRulesProblem } from '../lib/validation-rules';
import { BaseDataTypes } from '../lib/data-types';
import { ValidationError } from '../lib/errors';

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
    proxyTransformSchemeOptions: Object.fromEntries(
      Object.entries(g.proxyTransformSchemes).map(([name, def]) => [name, def.options]),
    ),
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

  /** loads a schema with the plugin read from its manifest, and with the plugin executed */
  async function loadBoth(items: string) {
    const schema = schemaFor(FIXTURE_DIR, items);
    const withoutManifest = copyFixture({ packageJson: (pkg) => delete pkg.exports['./manifest'] });
    const executed = await load(schema.replace(FIXTURE_DIR, withoutManifest), 'shape');
    const fromManifest = await load(schema, 'shape');
    await executed.g.resolveEnvValues();
    await fromManifest.g.resolveEnvValues();
    expect(fromManifest.g.plugins[0].loadedFromManifest).toBe(true);
    return { executed, fromManifest };
  }
  const errorsOf = ({ g }: { g: EnvGraph }, keys: Array<string>) => Object.fromEntries(keys.map((key) => [
    key,
    g.configSchema[key].errors.filter((e) => !e.isWarning).map((e) => ({ message: e.message, tip: (e as any).tip })),
  ]));

  test("a data type's validationRules give the same errors as the plugin's validate()", async () => {
    const { executed, fromManifest } = await loadBoth(outdent`
      # @type=manifestTestToken
      GOOD_TOKEN=mt_abc123
      # @type=manifestTestToken
      BAD_TOKEN=nope
      # @type=manifestTestToken
      SHORT_TOKEN=mt_ab
      # @type=array(manifestTestToken)
      TOKEN_LIST=mt_abc123,nope
    `);
    const keys = ['GOOD_TOKEN', 'BAD_TOKEN', 'SHORT_TOKEN', 'TOKEN_LIST'];
    const tokenError = { message: 'must start with mt_', tip: 'tokens look like mt_abc123' };
    expect(errorsOf(executed, keys)).toMatchObject({
      GOOD_TOKEN: [],
      BAD_TOKEN: [tokenError],
      SHORT_TOKEN: [{ message: 'too short', tip: undefined }],
      TOKEN_LIST: [{ message: expect.stringContaining('must start with mt_') }],
    });
    expect(errorsOf(fromManifest, keys)).toEqual(errorsOf(executed, keys));
    expect(fromManifest.g.configSchema.GOOD_TOKEN.resolvedValue).toBe('mt_abc123');
    expect(fromManifest.g.shapeSkipped.filter((s) => s.kind === 'validate')).toEqual([]);
  });

  test('a custom rule stops the static check: the value stays known, the skipped check is recorded', async () => {
    const { executed, fromManifest } = await loadBoth(outdent`
      # @type=manifestTestJson
      JSON_OK={"a":1}
      # @type=manifestTestJson
      NOT_OBJECT=[1]
      # @type=manifestTestJson
      NOT_JSON={nope
    `);
    const keys = ['JSON_OK', 'NOT_OBJECT', 'NOT_JSON'];
    expect(errorsOf(executed, keys)).toEqual({
      JSON_OK: [],
      NOT_OBJECT: [{ message: 'must be a JSON object', tip: undefined }],
      NOT_JSON: [{ message: 'must be valid JSON', tip: undefined }],
    });
    // the rule before the custom one still catches NOT_OBJECT, but only plugin code can say NOT_JSON is bad
    expect(errorsOf(fromManifest, keys)).toEqual({ ...errorsOf(executed, keys), NOT_JSON: [] });
    expect(fromManifest.g.configSchema.NOT_JSON.resolvedValue).toBe('{nope');
    expect(fromManifest.g.shapeSkipped.filter((s) => s.kind === 'validate')).toEqual([
      { kind: 'validate', name: 'manifestTestJson', itemKey: 'JSON_OK' },
      { kind: 'validate', name: 'manifestTestJson', itemKey: 'NOT_JSON' },
    ]);
    expect(executed.g.shapeSkipped.filter((s) => s.kind === 'validate')).toEqual([]);
  });

  test("a resolver's process() is still not carried by a manifest", async () => {
    const { executed, fromManifest } = await loadBoth('DYNAMIC=manifestFetch($PORT)');
    const messages = ({ g }: { g: EnvGraph }) => g.configSchema.DYNAMIC.errors
      .filter((e) => !e.isWarning).map((e) => e.message);
    expect(messages(executed)).toEqual(['manifestFetch(): expected a static name']);
    expect(messages(fromManifest)).toEqual([]);
  });

  test('a proxy transform scheme from a manifest checks transform configs like the plugin does', async () => {
    const proxySchema = (transform: string) => outdent`
      # @proxy(domain="api.example.com", transform={scheme="manifest-test-sign", ${transform}})
      # @sensitive
      SIGNING_SECRET=shh
      KEY_ID=abc
    `;
    for (const [transform, error] of [
      ['keyId=$KEY_ID, region=eu', undefined],
      ['keyId=$KEY_ID, regoin=eu', /unknown transform option "regoin" for scheme "manifest-test-sign"/],
      ['keyId=$KEY_ID, region=asia', /region/],
      ['region=eu', /keyId/],
    ] as const) {
      const { executed, fromManifest } = await loadBoth(proxySchema(transform));
      const outcome = async ({ g }: { g: EnvGraph }) => g.getProxyRules()
        .then((rules) => rules, (err: Error) => err.message);
      const fromExecuted = await outcome(executed);
      if (error) expect(fromExecuted).toMatch(error);
      else expect(fromExecuted).toMatchObject([{ transform: { scheme: 'manifest-test-sign', keyId: { itemRef: 'KEY_ID' } } }]);
      expect(await outcome(fromManifest)).toEqual(fromExecuted);
    }
  });

  test('a value whose type the plugin coerces in code is unknown, and so are values built from it', async () => {
    const schema = schemaFor(FIXTURE_DIR, outdent`
      PORT_COPY=$PORT
      PORT_URL=concat("http://localhost:", $PORT)
      # @type=array(manifestTestPort)
      PORTS=8080,9090
      # @type=record(manifestTestPort)
      PORT_MAP={"a":8080}
    `);
    const withoutManifest = copyFixture({ packageJson: (pkg) => delete pkg.exports['./manifest'] });
    const executed = await load(schema.replace(FIXTURE_DIR, withoutManifest), 'shape');
    const fromManifest = await load(schema, 'shape');
    await executed.g.resolveEnvValues();
    await fromManifest.g.resolveEnvValues();
    const keys = ['PORT', 'PORT_COPY', 'PORT_URL', 'PORTS', 'PORT_MAP'];
    const valuesOf = ({ g }: { g: EnvGraph }) => Object.fromEntries(keys.map((key) => {
      const item = g.configSchema[key];
      return [key, { value: item.resolvedValue, unknown: item.isValueUnknownInShapeLoad }];
    }));
    // control: running the plugin coerces the port to a number
    expect(valuesOf(executed)).toEqual({
      PORT: { value: 8080, unknown: false },
      PORT_COPY: { value: '8080', unknown: false },
      PORT_URL: { value: 'http://localhost:8080', unknown: false },
      PORTS: { value: [8080, 9090], unknown: false },
      PORT_MAP: { value: { a: 8080 }, unknown: false },
    });
    // from the manifest it can't, so it is unknown rather than the string "8080"
    expect(valuesOf(fromManifest)).toEqual({
      PORT: { value: undefined, unknown: true },
      PORT_COPY: { value: undefined, unknown: true },
      PORT_URL: { value: undefined, unknown: true },
      PORTS: { value: undefined, unknown: true },
      PORT_MAP: { value: undefined, unknown: true },
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
    ['has a rule with a regex that does not compile', { manifest: (m: any) => { m.dataTypes[0].validationRules[0] = { matches: '/a(/', message: 'x' }; } }, /unsupported value for "validationRules" \(rule 1 has an unsupported value for "matches"\)/],
    ['has a rule with two checks', { manifest: (m: any) => { m.dataTypes[0].validationRules[0].endsWith = 'x'; } }, /rule 1 must have exactly one of/],
    ['has a rule with no message', { manifest: (m: any) => { delete m.dataTypes[0].validationRules[1].message; } }, /rule 2 needs a "message"/],
    ['has a custom rule that is not last', { manifest: (m: any) => { m.dataTypes[2].validationRules.reverse(); } }, /rule 1 is custom, so it must be the last rule/],
    ['has a rule with an unknown check', { manifest: (m: any) => { m.dataTypes[0].validationRules[0] = { isEmail: true, message: 'x' }; } }, /rule 1 must have exactly one of/],
    ['has a malformed proxy option spec', { manifest: (m: any) => { m.proxyTransformSchemes[0].options.keyId.type = 'number'; } }, /proxy transform scheme|proxyTransformSchemes/],
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
    expect(await generatePluginManifest(FIXTURE_DIR)).toEqual({
      manifest: committed, manifestPath: path.join(FIXTURE_DIR, 'plugin-manifest.json'),
    });
  });

  test('generatePluginManifest refuses plugins it cannot describe', async () => {
    const singleFile = path.join(tmpDir, 'single.js');
    fs.writeFileSync(singleFile, "require('varlock/plugin-lib');");
    await expect(generatePluginManifest(singleFile)).rejects.toThrow(/Only plugin packages/);

    const dir = path.join(tmpDir, 'with-regexp');
    fs.mkdirSync(dir);
    const exports = { './plugin': './plugin.js', './manifest': './plugin-manifest.json' };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'with-regexp', exports }));
    fs.writeFileSync(path.join(dir, 'plugin.js'), outdent`
      const { plugin } = require('varlock/plugin-lib');
      plugin.registerResolverFunction({ name: 'rx', inferredTypeSettings: { matches: /x/ }, resolve: () => 'x' });
    `);
    await expect(generatePluginManifest(dir)).rejects.toThrow(/resolver "rx": unsupported value for "inferredTypeSettings"/);

    const writePlugin = (name: string, src: string) => {
      const pluginDir = path.join(tmpDir, name);
      fs.mkdirSync(pluginDir);
      fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name, exports }));
      fs.writeFileSync(path.join(pluginDir, 'plugin.js'), `const { plugin, ValidationError } = require('varlock/plugin-lib');\n${src}`);
      return pluginDir;
    };
    await expect(generatePluginManifest(writePlugin('no-rules', outdent`
      plugin.registerDataType({ name: 'noRules', validate: () => true });
    `))).rejects.toThrow(/"noRules" has validate\(\) but no validationRules/);
    await expect(generatePluginManifest(writePlugin('coerce-rules', outdent`
      plugin.registerDataType({ name: 'coerced', coerce: Number, validationRules: [{ minLength: 1, message: 'x' }] });
    `))).rejects.toThrow(/"coerced" coerces values in code/);
    await expect(generatePluginManifest(writePlugin('drift', outdent`
      plugin.registerDataType({
        name: 'drifted',
        validationRules: [{ startsWith: 'tok_', message: 'must start with tok_' }],
        validationSamples: ['tok_1', 'nope'],
        validate(val) { if (!val.startsWith('tok-')) throw new ValidationError('must start with tok-'); },
      });
    `))).rejects.toThrow(/validationRules that do not match its validate\(\)[\s\S]*"drifted": the rules accept "tok_1", but validate\(\) rejects it/);
    await expect(generatePluginManifest(writePlugin('scheme-hook', outdent`
      plugin.registerProxyTransformScheme({ scheme: 'hooked', options: {}, validate: () => undefined, apply: () => ({}) });
    `))).rejects.toThrow(/scheme "hooked" with validate\(\) or placeAttachedItem\(\)/);

    const noExport = copyFixture({ packageJson: (pkg) => delete pkg.exports['./manifest'] });
    await expect(generatePluginManifest(noExport)).rejects.toThrow(/has no "\.\/manifest" export/);
    const outside = copyFixture({
      packageJson: (pkg) => {
        pkg.exports['./manifest'] = '../outside.json';
      },
    });
    await expect(generatePluginManifest(outside)).rejects.toThrow(/outside its package/);
  });
});

describe('checkDataTypeValidationRules', () => {
  const startsWithAbc = (val: string) => {
    if (!val.startsWith('abc')) throw new ValidationError('must start with abc', { tip: 'like abc123' });
    if (val.length > 8) return new ValidationError('too long');
  };
  const rules = [
    { startsWith: 'abc', message: 'must start with abc', tip: 'like abc123' },
    { maxLength: 8, message: 'too long' },
  ];

  test('passes when the rules say what validate() says', async () => {
    expect(await checkDataTypeValidationRules({ name: 't', validate: startsWithAbc, validationRules: rules })).toEqual([]);
  });

  test('finds a different message, a different tip, and a boundary the rules get wrong', async () => {
    expect(await checkDataTypeValidationRules({
      name: 't', validate: startsWithAbc, validationRules: [{ ...rules[0], message: 'must begin with abc' }, rules[1]],
    })).toContainEqual(expect.stringMatching(/rule 1 gives "must begin with abc", but validate\(\) gives "must start with abc"/));
    expect(await checkDataTypeValidationRules({
      name: 't', validate: startsWithAbc, validationRules: [{ ...rules[0], tip: 'other' }, rules[1]],
    })).toContainEqual(expect.stringMatching(/\(or a different tip\)/));
    // values cut to just around the length are derived from the given samples, so this is found
    // without a sample of exactly the wrong length
    expect(await checkDataTypeValidationRules({
      name: 't', validate: startsWithAbc, validationRules: [rules[0], { maxLength: 7, message: 'too long' }], validationSamples: ['abc12345678'],
    })).toContainEqual(expect.stringMatching(/rule 2 rejects "abc12345", but validate\(\) accepts it/));
  });

  test('needs a sample that fails each rule, and one that passes', async () => {
    expect(await checkDataTypeValidationRules({
      name: 't', validate: () => true, validationRules: [{ matches: '/^/', message: 'never fails' }],
    })).toEqual(['data type "t": no sample fails rule 1 (matches), add one to validationSamples']);

    const fiveDigits = [{ matches: '/^[0-9]{5}$/', message: 'five digits' }];
    const validate = (val: string) => (/^[0-9]{5}$/.test(val) ? true : new ValidationError('five digits'));
    // none of the values derived from the rules pass this one
    expect(await checkDataTypeValidationRules({ name: 't', validate, validationRules: fiveDigits }))
      .toEqual(['data type "t": no sample passes the rules, add one to validationSamples']);
    expect(await checkDataTypeValidationRules({
      name: 't', validate, validationRules: fiveDigits, validationSamples: ['12345'],
    })).toEqual([]);
  });

  test('says nothing about values past a custom rule', async () => {
    const validate = (val: string) => {
      if (!val) throw new ValidationError('empty');
      JSON.parse(val);
    };
    expect(await checkDataTypeValidationRules({
      name: 't', validate, validationRules: [{ minLength: 1, message: 'empty' }, { custom: 'parses as JSON' }],
    })).toEqual([]);
  });
});

describe('validation rules', () => {
  test('a matches rule reads its pattern the same way as string(matches=...)', async () => {
    const stringType = BaseDataTypes.find((t) => t.dataTypeName === 'string')!;
    const stringPasses = async (matches: string, val: string) => (await stringType({ matches }).validate(val)) === true;
    const rulePasses = (matches: string, val: string) => {
      const result = checkValidationRules(val, [{ matches, message: 'no match' }]);
      return result.passed === true;
    };
    // a regex-like string that does not compile (a repeated flag) is a literal pattern
    expect(findValidationRulesProblem([{ matches: '/abc/gg', message: 'no match' }])).toBeUndefined();
    for (const val of ['/abc/gg', 'abc']) {
      expect(rulePasses('/abc/gg', val)).toBe(await stringPasses('/abc/gg', val));
    }
    expect(rulePasses('/abc/gg', 'x/abc/ggx')).toBe(true);
    expect(rulePasses('/abc/gg', 'abc')).toBe(false);
    // a pattern that does not compile either way is not a usable rule
    expect(findValidationRulesProblem([{ matches: '/a(/', message: 'no match' }])).toMatch(/unsupported value for "matches"/);
  });
});
