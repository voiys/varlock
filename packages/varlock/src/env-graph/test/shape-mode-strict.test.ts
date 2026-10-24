import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import outdent from 'outdent';
import {
  EnvGraph, DotEnvFileDataSource, collectTypeGenItems, generateTsTypesSrc, resolveFieldTypes,
} from '../index';

// The fixture plugin counts its own module executions in this global. Every "it did not run" assertion
// has a control where the same schema does run it.
const FIXTURE_DIR = path.join(__dirname, 'plugins/test-plugin-manifest');
const pluginRuns = () => (globalThis as any).__varlockManifestTestPluginRuns ?? 0;

type GraphOpts = ConstructorParameters<typeof EnvGraph>[0];

async function load(schema: string, opts: GraphOpts) {
  const g = new EnvGraph(opts);
  const source = new DotEnvFileDataSource(path.join(__dirname, '.env.schema'), { overrideContents: schema });
  await g.setRootDataSource(source);
  await g.finishLoad();
  if (g.configItemsProcessed) await g.resolveEnvValues();
  return g;
}

const messages = (errs: Array<{ message: string, isWarning?: boolean }>) => errs.map((e) => `${e.isWarning ? 'warning' : 'error'}: ${e.message}`);

describe('shape mode with runPluginCode: false', () => {
  // the fixture plugin without its manifest export: a plugin that ships no manifest
  let noManifestDir: string;
  beforeAll(() => {
    noManifestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-no-manifest-'));
    fs.cpSync(FIXTURE_DIR, noManifestDir, { recursive: true });
    const pkgPath = path.join(noManifestDir, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    delete pkg.exports['./manifest'];
    fs.writeFileSync(pkgPath, JSON.stringify(pkg));
  });
  afterAll(() => fs.rmSync(noManifestDir, { recursive: true, force: true }));

  const schemaFor = (dir: string) => outdent`
    # @plugin(${dir}/)
    # @initManifestTest(token=$TOKEN)
    # @generateManifestTestFile(path=./manifest-test.txt, flavor=plain)
    # @defaultSensitive=false
    # ---
    # @type=manifestTestToken
    TOKEN=mt_abc
    # @type=manifestTestPort(max=10000)
    PORT=8080
    SECRET=manifestFetch(name)
    # @manifestTag
    TAGGED=x
    PLAIN=hello
  `;

  test('a plugin without a manifest is not run, and what it registers is unknown', async () => {
    const before = pluginRuns();
    const g = await load(schemaFor(noManifestDir), { mode: 'shape', runPluginCode: false });
    expect(pluginRuns()).toBe(before);
    expect(g.runPluginCode).toBe(false);
    expect(g.plugins).toHaveLength(0);

    // reported, as warnings: the schema itself is not wrong
    const sourceMessages = messages(g.sortedDataSources.flatMap((s) => s.errors));
    expect(sourceMessages).toEqual([
      'warning: Plugin @varlock/test-plugin-manifest was not loaded: it ships no manifest, and shape mode is set to never run plugin code',
      'warning: Unknown decorator: @initManifestTest (it may come from @varlock/test-plugin-manifest, which was not loaded)',
      'warning: Unknown decorator: @generateManifestTestFile (it may come from @varlock/test-plugin-manifest, which was not loaded)',
    ]);
    expect(messages(g.configSchema.TOKEN.errors)).toEqual(['warning: unknown data type: manifestTestToken (it may come from @varlock/test-plugin-manifest, which was not loaded)']);
    expect(messages(g.configSchema.TAGGED.errors)).toEqual(['warning: Unknown decorator: @manifestTag (it may come from @varlock/test-plugin-manifest, which was not loaded)']);
    // fail closed: a value from an unknown function counts as sensitive
    expect(messages(g.configSchema.SECRET.errors)).toEqual([expect.stringMatching(/^warning: implicitly treated as @sensitive/)]);

    // values that need the plugin are unknown, the rest are not affected
    for (const key of ['TOKEN', 'PORT', 'SECRET']) {
      expect(g.configSchema[key].isValueUnknownInShapeLoad).toBe(true);
      expect(g.configSchema[key].resolvedValue).toBeUndefined();
    }
    expect(g.configSchema.PLAIN.resolvedValue).toBe('hello');
    expect(g.configSchema.TAGGED.resolvedValue).toBe('x');
    // fail closed: a plugin type or function may carry a secret
    expect(g.configSchema.TOKEN.isSensitive).toBe(true);
    expect(g.configSchema.SECRET.isSensitive).toBe(true);
    expect(g.configSchema.PLAIN.isSensitive).toBe(false);

    expect(g.shapeSkipped).toEqual(expect.arrayContaining([
      { kind: 'pluginCode', name: '@varlock/test-plugin-manifest' },
      { kind: 'resolver', name: 'manifestFetch', itemKey: 'SECRET' },
      { kind: 'coerce', name: 'manifestTestPort', itemKey: 'PORT' },
    ]));
    // types still generate; plugin types are strings
    const ts = await generateTsTypesSrc(resolveFieldTypes(await collectTypeGenItems(g)));
    expect(ts).toMatch(/PORT: string;/);
    expect(ts).toMatch(/SECRET: string;/);
  });

  test('control: by default shape mode runs a plugin without a manifest', async () => {
    const before = pluginRuns();
    const g = await load(schemaFor(noManifestDir), { mode: 'shape' });
    expect(pluginRuns()).toBe(before + 1);
    expect(g.runPluginCode).toBe(true);
    expect(g.configSchema.PORT.resolvedValue).toBe(8080);
    expect(g.shapeSkipped.some((s) => s.kind === 'pluginCode')).toBe(false);
  });

  test('a plugin with a manifest is still read from it', async () => {
    const before = pluginRuns();
    const g = await load(schemaFor(FIXTURE_DIR), { mode: 'shape', runPluginCode: false });
    expect(pluginRuns()).toBe(before);
    expect(g.plugins[0]?.loadedFromManifest).toBe(true);
    expect(messages(g.sortedDataSources.flatMap((s) => s.errors))).toEqual([]);
    expect(g.configSchema.TOKEN.errors.filter((e) => !e.isWarning)).toEqual([]);
  });

  test('names that no loaded plugin could explain are still errors when every plugin loaded', async () => {
    const g = await load(outdent`
      # @plugin(${FIXTURE_DIR}/)
      # ---
      # @type=noSuchType @noSuchDecorator
      A=noSuchFn()
    `, { mode: 'shape', runPluginCode: false });
    expect(messages(g.configSchema.A.errors)).toEqual(expect.arrayContaining([
      'error: Unknown decorator: @noSuchDecorator',
      'error: Unknown resolver function: noSuchFn()',
    ]));
  });

  test('only supported in shape mode', () => {
    expect(() => new EnvGraph({ runPluginCode: false })).toThrow(/only supported in shape mode/);
    expect(() => new EnvGraph({ mode: 'default', runPluginCode: false })).toThrow(/only supported in shape mode/);
  });
});

describe('shape mode runs schema regexes in linear time', () => {
  // `^(a+)+$` against n a's and a `!` backtracks 2^n times on a backtracking engine: about 5 s at
  // n = 30 on a laptop, so a run under a second means the engine did not backtrack
  const EVIL = '"^(a+)+$"';
  const victim = `${'a'.repeat(30)}!`;

  test.each([
    ['string(matches=regex())', `# @type=string(matches=regex(${EVIL}))\nA=${victim}`],
    ['string(matches="/.../")', `# @type=string(matches="/^(a+)+$/")\nA=${victim}`],
    ['url(matches=regex())', `# @type=url(matches=regex("(a+)+$"))\nA=https://example.com/${victim}`],
    ['array(string(matches=regex()))', `# @type=array(string(matches=regex(${EVIL})))\nA=${victim}`],
    ['remap() with regex()', `V=${victim}\nA=remap($V, regex(${EVIL}), yes, no)`],
    ['remap() with a /.../ string', `V=${victim}\nA=remap($V, "/^(a+)+$/", yes, no)`],
  ])('%s', async (_label, items) => {
    const t0 = performance.now();
    const g = await load(`# @defaultSensitive=false\n# ---\n${items}`, { mode: 'shape' });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(g.configItemsProcessed).toBe(true);
  });

  test('a normal regex validates exactly as in default mode', async () => {
    const schema = outdent`
      # @defaultSensitive=false
      # ---
      # @type=string(matches=regex("^sk_[a-z0-9]{4}$"))
      GOOD=sk_ab12
      # @type=string(matches=regex("^sk_[a-z0-9]{4}$"))
      BAD=sk_AB12
      # @type=string(matches=/^sk_/i)
      CASE=SK_x
      # @type=string(matches=regex("^\\S+$"))
      SPACE="a${'\u00a0'}b"
      MAPPED=remap($GOOD, regex("^sk_"), live, other)
    `;
    const shapeGraph = await load(schema, { mode: 'shape' });
    const control = await load(schema, { mode: 'default' });
    for (const key of ['GOOD', 'BAD', 'CASE', 'SPACE', 'MAPPED']) {
      expect(messages(shapeGraph.configSchema[key].errors), key).toEqual(messages(control.configSchema[key].errors));
      expect(shapeGraph.configSchema[key].resolvedValue, key).toEqual(control.configSchema[key].resolvedValue);
    }
    expect(messages(shapeGraph.configSchema.BAD.errors)).toEqual(['error: Value must match regex "/^sk_[a-z0-9]{4}$/"']);
    expect(shapeGraph.configSchema.SPACE.errors).toHaveLength(1); // JS \s includes a no-break space; RE2's does not
    expect(shapeGraph.configSchema.MAPPED.resolvedValue).toBe('live');
    expect(shapeGraph.shapeSkipped.filter((s) => s.kind === 'regex')).toEqual([]);
  });

  test('a pattern RE2 cannot run exactly is unknown, not an error and not a wrong answer', async () => {
    const g = await load(outdent`
      # @defaultSensitive=false
      # ---
      # @type=string(matches=regex("^(a)\\1$"))
      BACKREF=ab
      V=ab
      MAPPED=remap($V, regex("^(?=a)b"), matched, unmatched)
    `, { mode: 'shape' });
    expect(g.configSchema.BACKREF.errors).toEqual([]);
    expect(g.configSchema.MAPPED.resolvedValue).toBeUndefined();
    expect(g.configSchema.MAPPED.isValueUnknownInShapeLoad).toBe(true);
    expect(g.shapeSkipped).toEqual(expect.arrayContaining([
      { kind: 'regex', name: '/^(a)\\1$/', itemKey: 'BACKREF' },
      { kind: 'regex', name: 'regex("^(?=a)b")' },
    ]));
    // control: default mode evaluates both with the JS engine
    const control = await load(outdent`
      # @defaultSensitive=false
      # ---
      # @type=string(matches=regex("^(a)\\1$"))
      BACKREF=ab
      V=ab
      MAPPED=remap($V, regex("^(?=a)b"), matched, unmatched)
    `, { mode: 'default' });
    expect(control.configSchema.BACKREF.errors).toHaveLength(1);
    expect(control.configSchema.MAPPED.resolvedValue).toBe('unmatched');
  });
});
