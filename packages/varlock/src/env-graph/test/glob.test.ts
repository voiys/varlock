/*
  Globs without regexes: the linear matcher behind key filters (@import / @setValuesBulk
  pick/omit, @auditIgnoreKeys), and glob() as a remap() match value.
*/

import { describe, it, expect } from 'vitest';
import { outdent } from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../index';
import { compileGlob } from '../lib/glob';
import { ParsedItemFilter } from '../lib/item-filter';
import { ResolutionError, SchemaError } from '../lib/errors';

async function loadAndResolve(envFileContent: string) {
  const g = new EnvGraph();
  await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
    overrideContents: outdent`
      # @defaultRequired=false @defaultSensitive=false
      # ---
      ${envFileContent}
    `,
  }));
  await g.finishLoad();
  await g.resolveEnvValues();
  return g;
}

/** what globs used to compile to, kept here as the reference for the semantics */
function legacyGlobToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

describe('compileGlob', () => {
  it.each([
    ['API_KEY', 'API_KEY', true],
    ['API_KEY', 'API_KEYS', false],
    ['API_*', 'API_KEY', true],
    ['API_*', 'API_', true],
    ['API_*', 'XAPI_KEY', false],
    ['*_KEY', 'STRIPE_KEY', true],
    ['*_KEY', 'STRIPE_KEY_2', false],
    ['*', '', true],
    ['', '', true],
    ['', 'A', false],
    ['A?C', 'ABC', true],
    ['A?C', 'AC', false],
    ['A*B*C', 'AxxBxxC', true],
    ['A*B*C', 'AxxCxxB', false],
    ['**', 'anything', true],
    ['api_*', 'API_KEY', false], // case-sensitive
    ['a.b', 'a.b', true],
    ['a.b', 'axb', false], // regex specials are literal
    ['(a)+[b]{1}$^|\\', '(a)+[b]{1}$^|\\', true],
  ])('%j against %j is %s', (pattern, str, expected) => {
    expect(compileGlob(pattern).test(str)).toBe(expected);
  });

  it('never matches a value with a line terminator, like the regex it replaced', () => {
    for (const str of ['a\nb', 'a\rb', 'a\u2028b', 'a\u2029b']) {
      expect(compileGlob('*').test(str)).toBe(false);
      expect(legacyGlobToRegExp('*').test(str)).toBe(false);
    }
  });

  it('agrees with the regex it replaced on generated patterns and keys', () => {
    const alphabet = ['A', 'B', '_', '*', '?', '.'];
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const randomString = (chars: Array<string>, maxLen: number) => Array.from(
      { length: rand(maxLen + 1) },
      () => chars[rand(chars.length)],
    ).join('');
    for (let i = 0; i < 3000; i++) {
      const pattern = randomString(alphabet, 6);
      const key = randomString(['A', 'B', '_', '.'], 8);
      expect(compileGlob(pattern).test(key), `${pattern} vs ${key}`).toBe(legacyGlobToRegExp(pattern).test(key));
    }
  });

  it('stays fast on a pattern that made the regex backtrack', () => {
    // `pick=[*A*A*A*A*A*A*A*B]` against a ~60 character key took about a minute as a regex
    const key = 'A'.repeat(60);
    const started = performance.now();
    expect(compileGlob('*A*A*A*A*A*A*A*B').test(key)).toBe(false);
    expect(compileGlob(`${'*A'.repeat(30)}*B`).test('A'.repeat(10_000))).toBe(false);
    expect(compileGlob(`${'*A'.repeat(30)}*B`).test(`${'A'.repeat(10_000)}B`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('key filters use the linear matcher', () => {
  const items = ['API_KEY', 'API_SECRET', 'DB_URL', 'A'.repeat(60)].map((key) => ({
    key, isSensitive: false, isRequired: false, isDynamic: false, tags: [],
  }));

  it('keeps glob and negation semantics', () => {
    expect([...new ParsedItemFilter(['API_*', '!*_SECRET'], 'pick').computeKeys(items)]).toEqual(['API_KEY']);
    expect([...new ParsedItemFilter(['?B_*'], 'pick').computeKeys(items)]).toEqual(['DB_URL']);
  });

  it('is fast on the pathological pattern', () => {
    const started = performance.now();
    expect([...new ParsedItemFilter(['*A*A*A*A*A*A*A*B'], 'pick').computeKeys(items)]).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('glob() as a remap() match value', () => {
  it.each([
    ['main', 'production'],
    ['feature/login', 'preview'],
    ['', 'development'],
  ])('remap($WORKERS_CI_BRANCH, "main", production, glob("*"), preview, undefined, development) with %j', async (branch, expected) => {
    // the real-world `regex(.*)` line, rewritten
    const g = await loadAndResolve(outdent`
      WORKERS_CI_BRANCH=${branch}
      APP_ENV=remap($WORKERS_CI_BRANCH, "main", production, glob("*"), preview, undefined, development)
    `);
    expect(g.configSchema.APP_ENV.resolvedValue).toBe(expected);
    expect(g.configSchema.APP_ENV.validationState).toBe('valid');
  });

  it.each([
    ['preview', 'preview'],
    ['pr-123-preview-env', 'preview'],
    ['production', 'production'],
    ['prod-eu', 'production'],
    ['test', 'test'],
    ['local', 'development'],
  ])('the real-world contains-style remap, with %j', async (varlockEnv, expected) => {
    const g = await loadAndResolve(outdent`
      VARLOCK_ENV_VALUE=${varlockEnv}
      APP_ENV=remap($VARLOCK_ENV_VALUE, glob("*preview*"), preview, glob("*production*"), production, glob("*prod*"), production, glob("*test*"), test, glob("*"), development)
      LEGACY=remap($VARLOCK_ENV_VALUE, regex("preview"), preview, regex("production"), production, regex("prod"), production, regex("test"), test, regex(".*"), development)
    `);
    expect(g.configSchema.APP_ENV.resolvedValue).toBe(expected);
    expect(g.configSchema.LEGACY.resolvedValue).toBe(expected);
    expect(g.configSchema.APP_ENV.validationState).toBe('valid');
  });

  it('matches the whole value, case-sensitively, with ? for one character', async () => {
    const g = await loadAndResolve(outdent`
      SRC=release-7
      WHOLE=remap($SRC, glob("release"), hit, miss)
      ONE=remap($SRC, glob("release-?"), hit, miss)
      CASE=remap($SRC, glob("RELEASE-*"), hit, miss)
      LEGACY_SYNTAX=remap($SRC, hit=glob("release-*"))
    `);
    expect(g.configSchema.WHOLE.resolvedValue).toBe('miss');
    expect(g.configSchema.ONE.resolvedValue).toBe('hit');
    expect(g.configSchema.CASE.resolvedValue).toBe('miss');
    expect(g.configSchema.LEGACY_SYNTAX.resolvedValue).toBe('hit');
  });

  it('does not match an unset value', async () => {
    const g = await loadAndResolve(outdent`
      SRC=
      R=remap($SRC, glob("*"), hit, miss)
    `);
    expect(g.configSchema.R.resolvedValue).toBe('miss');
  });

  it('takes a static pattern only', async () => {
    const g = await loadAndResolve(outdent`
      PAT=a*
      SRC=abc
      DYNAMIC=remap($SRC, glob($PAT), hit, miss)
      NONE=remap($SRC, glob(), hit, miss)
      TWO=remap($SRC, glob("a", "b"), hit, miss)
    `);
    for (const key of ['DYNAMIC', 'NONE', 'TWO']) {
      expect(g.configSchema[key].errors[0], key).toBeInstanceOf(SchemaError);
    }
    expect(g.configSchema.DYNAMIC.errors[0].message).toContain('glob(): expects a static pattern');
  });

  it('is not a value on its own', async () => {
    const g = await loadAndResolve('G=glob("a*")');
    expect(g.configSchema.G.resolutionError).toBeInstanceOf(ResolutionError);
    expect(g.configSchema.G.resolutionError?.message).toContain('glob() values are meant to be used as remap() match values');
  });
});

describe('regex match values in remap() are deprecated', () => {
  it('warns on regex(), naming the glob() for each simple pattern', async () => {
    const g = await loadAndResolve(outdent`
      SRC=feature
      R=remap($SRC, "main", production, regex(".*"), preview)
      C=remap($SRC, regex("preview"), preview, regex("^prod"), production, regex("^v[0-9]+$"), release, other)
    `);
    expect(g.configSchema.R.resolvedValue).toBe('preview');
    expect(g.configSchema.R.validationState).toBe('warn');
    const [warning] = g.configSchema.R.errors;
    expect(warning.isWarning).toBe(true);
    expect(warning.message).toBe('remap(): regex match values are deprecated, use glob() or an exact value instead');
    expect(warning.tip).toContain('write regex(".*") as glob("*")');

    const tip = g.configSchema.C.errors[0].tip;
    expect(tip).toContain('write regex("preview") as glob("*preview*")');
    expect(tip).toContain('write regex("^prod") as glob("prod*")');
    // not expressible as a glob, so no rewrite is offered
    expect(tip).not.toContain('regex("^v[0-9]+$") as');
  });

  it('warns on a /.../ string', async () => {
    const g = await loadAndResolve(outdent`
      SRC=dev-1
      R=remap($SRC, /^dev-./, hit, miss)
    `);
    expect(g.configSchema.R.resolvedValue).toBe('hit');
    expect(g.configSchema.R.errors[0].tip).toContain('write /^dev-./ as glob("dev-?*")');
  });

  it('does not warn on glob() or exact values', async () => {
    const g = await loadAndResolve(outdent`
      SRC=dev
      R=remap($SRC, glob("d*"), hit, "/usr/local", path, miss)
    `);
    expect(g.configSchema.R.validationState).toBe('valid');
  });
});
