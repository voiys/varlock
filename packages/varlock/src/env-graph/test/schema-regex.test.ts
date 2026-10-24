import {
  describe, test, expect, vi,
} from 'vitest';
import path from 'node:path';
import outdent from 'outdent';
import { EnvGraph, DotEnvFileDataSource } from '../index';

type Mode = 'default' | 'shape';

async function load(schema: string, mode: Mode) {
  const g = new EnvGraph({ mode });
  const source = new DotEnvFileDataSource(path.join(__dirname, '.env.schema'), { overrideContents: schema });
  await g.setRootDataSource(source);
  await g.finishLoad();
  if (g.configItemsProcessed) await g.resolveEnvValues();
  return g;
}

const messages = (errs: Array<{ message: string, isWarning?: boolean }>) => errs.map((e) => `${e.isWarning ? 'warning' : 'error'}: ${e.message}`);

const FALLBACK = 'which the linear-time regex engine does not support. It runs on the JavaScript regex engine for now, but this fallback will be removed in a future version';
const NOT_RUN = 'which the linear-time regex engine does not support, so shape mode does not run it and whether the value matches is unknown';

describe('schema regexes run in linear time in every mode', () => {
  // `^(a+)+$` against n a's and a `!` backtracks 2^n times on a backtracking engine: about 5 s at
  // n = 30 on a laptop, so a run under a second means the engine did not backtrack
  const EVIL = '"^(a+)+$"';
  const victim = `${'a'.repeat(30)}!`;

  const cases: Array<[string, string]> = [
    ['string(matches=regex())', `# @type=string(matches=regex(${EVIL}))\nA=${victim}`],
    ['string(matches="/.../")', `# @type=string(matches="/^(a+)+$/")\nA=${victim}`],
    ['url(matches=regex())', `# @type=url(matches=regex("(a+)+$"))\nA=https://example.com/${victim}`],
    ['array(string(matches=regex()))', `# @type=array(string(matches=regex(${EVIL})))\nA=${victim}`],
    ['remap() with regex()', `V=${victim}\nA=remap($V, regex(${EVIL}), yes, no)`],
    ['remap() with a /.../ string', `V=${victim}\nA=remap($V, "/^(a+)+$/", yes, no)`],
  ];
  test.each((['default', 'shape'] as const).flatMap((mode) => cases.map(([label, items]) => [mode, label, items])))(
    '%s mode: %s',
    async (mode, _label, items) => {
      const t0 = performance.now();
      const g = await load(`# @defaultSensitive=false\n# ---\n${items}`, mode as Mode);
      expect(performance.now() - t0).toBeLessThan(1000);
      expect(g.configItemsProcessed).toBe(true);
      expect(g.configSchema.A.errors.filter((e) => !e.isWarning)).toHaveLength(items.startsWith('#') ? 1 : 0);
    },
  );

  test('a normal regex validates exactly as on the JavaScript engine, without a warning', async () => {
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
      SPACE="a${' '}b"
      MAPPED=remap($GOOD, regex("^sk_"), live, other)
    `;
    for (const mode of ['default', 'shape'] as const) {
      const g = await load(schema, mode);
      expect(messages(g.configSchema.GOOD.errors), mode).toEqual([]);
      expect(messages(g.configSchema.BAD.errors), mode).toEqual(['error: Value must match regex "/^sk_[a-z0-9]{4}$/"']);
      expect(messages(g.configSchema.CASE.errors), mode).toEqual([expect.stringMatching(/^warning: .*string patterns are deprecated/)]);
      // JS \s includes a no-break space; RE2's does not, so the pattern is translated
      expect(messages(g.configSchema.SPACE.errors), mode).toEqual(['error: Value must match regex "/^\\S+$/"']);
      expect(g.configSchema.MAPPED.resolvedValue, mode).toBe('live');
      expect(g.shapeSkipped.filter((skip) => skip.kind === 'regex'), mode).toEqual([]);
    }
  });
});

describe('a pattern the linear-time engine does not support', () => {
  // the negative lookahead real schemas use, written as they write it
  const schema = outdent`
    # @defaultSensitive=false
    # ---
    # @type=url(matches=regex("^(?!https?://example[.]convex[.])"))
    REAL=https://happy-otter-123.convex.cloud
    # @type=url(matches=regex("^(?!https?://example[.]convex[.])"))
    PLACEHOLDER=https://example.convex.cloud
    # @type=string(matches=regex("^(a)\\1$"))
    BACKREF=ab
    V=ab
    MAPPED=remap($V, regex("^(?<=x)a"), matched, unmatched)
  `;
  const typeWarning = (pattern: string, feature: string, tail: string) => (
    `warning: @type=url(...) - option "matches" - regex ${pattern} uses ${feature}, ${tail}`
  );

  test('default mode: falls back to the JavaScript engine, validates as before, and warns', async () => {
    const g = await load(schema, 'default');
    const lookahead = typeWarning('/^(?!https?:\\/\\/example[.]convex[.])/', 'lookahead', FALLBACK);
    expect(messages(g.configSchema.REAL.errors)).toEqual([lookahead]);
    expect(messages(g.configSchema.PLACEHOLDER.errors)).toEqual([
      lookahead,
      'error: URL must match regex "/^(?!https?:\\/\\/example[.]convex[.])/"',
    ]);
    expect(messages(g.configSchema.BACKREF.errors)).toEqual([
      `warning: @type=string(...) - option "matches" - regex /^(a)\\1$/ uses a backreference (or an octal escape), ${FALLBACK}`,
      'error: Value must match regex "/^(a)\\1$/"',
    ]);
    expect(g.configSchema.MAPPED.resolvedValue).toBe('unmatched');
    expect(messages(g.configSchema.MAPPED.errors)).toEqual([`warning: regex(): regex /^(?<=x)a/ uses lookbehind, ${FALLBACK}`]);
  });

  test('shape mode: warns, does not run the JavaScript engine, and the result is unknown', async () => {
    // a lookahead in front of a catastrophic pattern: the JS engine would take seconds on this input
    const evil = '^(?!x)(a+)+$';
    const exec = vi.spyOn(RegExp.prototype, 'exec');
    const t0 = performance.now();
    const g = await load(outdent`
      ${schema}
      # @type=string(matches=regex("${evil}"))
      EVIL=${'a'.repeat(30)}!
    `, 'shape');
    const elapsed = performance.now() - t0;
    const ranOnJs = exec.mock.contexts.some((re) => (re as RegExp).source === evil);
    exec.mockRestore();
    expect(elapsed).toBeLessThan(1000);
    expect(ranOnJs).toBe(false);

    const lookahead = typeWarning('/^(?!https?:\\/\\/example[.]convex[.])/', 'lookahead', NOT_RUN);
    // a warning, never an error: whether the value matches is unknown
    expect(messages(g.configSchema.REAL.errors)).toEqual([lookahead]);
    expect(messages(g.configSchema.PLACEHOLDER.errors)).toEqual([lookahead]);
    expect(messages(g.configSchema.BACKREF.errors)).toEqual([`warning: @type=string(...) - option "matches" - regex /^(a)\\1$/ uses a backreference (or an octal escape), ${NOT_RUN}`]);
    expect(messages(g.configSchema.EVIL.errors)).toEqual([`warning: @type=string(...) - option "matches" - regex /${evil}/ uses lookahead, ${NOT_RUN}`]);
    expect(g.configSchema.MAPPED.resolvedValue).toBeUndefined();
    expect(g.configSchema.MAPPED.isValueUnknownInShapeLoad).toBe(true);
    expect(messages(g.configSchema.MAPPED.errors)).toEqual([`warning: regex(): regex /^(?<=x)a/ uses lookbehind, ${NOT_RUN}`]);
    expect(g.shapeSkipped).toEqual(expect.arrayContaining([
      { kind: 'regex', name: '/^(?!https?:\\/\\/example[.]convex[.])/', itemKey: 'PLACEHOLDER' },
      { kind: 'regex', name: '/^(a)\\1$/', itemKey: 'BACKREF' },
      { kind: 'regex', name: `/${evil}/`, itemKey: 'EVIL' },
      { kind: 'regex', name: 'regex("^(?<=x)a")' },
    ]));
  });
});
