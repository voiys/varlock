import { describe, expect, test } from 'vitest';
import { outdent } from 'outdent';

import {
  extractCallKeys, extractPropKeys, isEnvKeyName, tokenizeSource, type SourceLanguage,
} from '../code-key-extractor';

const callKeys = (src: string, names: Array<string>, arg?: number, lang: SourceLanguage | undefined = 'js-like') => (
  extractCallKeys(tokenizeSource(src, lang), names, arg).map((k) => k.key)
);
const propKeys = (src: string, names: Array<string>, lang: SourceLanguage | undefined = 'js-like') => (
  extractPropKeys(tokenizeSource(src, lang), names).map((k) => k.key)
);

describe('calls=', () => {
  // real case: @auditExtraPatterns(regex('(?:requireEnv|requireStrongSecret|isFlagEnabled)\(\s*\'([A-Z0-9_]+)\'\)'))
  const names = ['requireEnv', 'requireStrongSecret', 'isFlagEnabled'];

  test('finds the key passed to each named function', () => {
    expect(callKeys(outdent`
      const db = requireEnv('DATABASE_URL');
      const secret = requireStrongSecret( 'SESSION_SECRET' );
      if (isFlagEnabled("NEW_CHECKOUT")) {}
      const other = somethingElse('NOT_A_KEY');
    `, names)).toEqual(['DATABASE_URL', 'SESSION_SECRET', 'NEW_CHECKOUT']);
  });

  test('finds several calls on one line, and calls nested in other calls', () => {
    expect(callKeys(
      "connect(requireEnv('DB_HOST'), Number(requireEnv('DB_PORT')), { tls: isFlagEnabled('DB_TLS') });",
      names,
    )).toEqual(['DB_HOST', 'DB_PORT', 'DB_TLS']);
    expect(callKeys("requireEnv(requireEnv('INNER'))", names)).toEqual(['INNER']);
  });

  test('skips a name inside a string or a comment', () => {
    expect(callKeys(outdent`
      // requireEnv('IN_LINE_COMMENT')
      /* requireEnv('IN_BLOCK_COMMENT') */
      const help = "call requireEnv('IN_DOUBLE_QUOTES') first";
      const help2 = 'see requireEnv("IN_SINGLE_QUOTES")';
      const help3 = \`requireEnv('IN_TEMPLATE')\`;
      const ok = requireEnv('REAL'); // requireEnv('TRAILING_COMMENT')
    `, names)).toEqual(['REAL']);
  });

  test('finds calls inside template literal interpolations', () => {
    // eslint-disable-next-line no-template-curly-in-string
    expect(callKeys('const url = `https://${requireEnv(\'HOST\')}/path`;', names)).toEqual(['HOST']);
  });

  test('only takes an argument that is exactly one string literal', () => {
    expect(callKeys(outdent`
      requireEnv(name);
      requireEnv('PREFIX_' + suffix);
      requireEnv(\`TEMPLATE_\${x}\`);
      requireEnv(\`PLAIN_TEMPLATE\`);
      requireEnv('WITH_DEFAULT', 'fallback');
      requireEnv('not a key');
      requireEnv('1_LEADING_DIGIT');
      requireEnv();
    `, names)).toEqual(['PLAIN_TEMPLATE', 'WITH_DEFAULT']);
  });

  test('ignores a declaration or a reference without a call', () => {
    expect(callKeys(outdent`
      function requireEnv(name: string): string { return process.env[name]!; }
      const fn = requireEnv;
      export { requireEnv };
    `, names)).toEqual([]);
  });

  test('arg=N picks another argument', () => {
    // real case: @auditExtraPatterns(regex('(?:setting|choice|integer|positiveNumber)\(\s*env,\s*"([A-Z_]+)"'), fileTypes=[ts])
    const settingNames = ['setting', 'choice', 'integer', 'positiveNumber'];
    expect(callKeys(outdent`
      export const config = {
        port: positiveNumber(env, "PORT", 3000),
        mode: choice(env, "LOG_LEVEL", ["debug", "info"]),
        retries: integer(
          env,
          "MAX_RETRIES",
        ),
        name: setting(env, "APP_NAME"),
        nested: setting(pick(env, "IGNORED_INNER"), "OUTER"),
        wrong: setting("FIRST_ARG_ONLY"),
      };
    `, settingNames, 2)).toEqual(['PORT', 'LOG_LEVEL', 'MAX_RETRIES', 'APP_NAME', 'OUTER']);
  });

  test('a dotted name matches the end of the callee, generics allowed', () => {
    const src = outdent`
      const a = this.configService.get<string>('DATABASE_URL');
      const b = configService.get('REDIS_URL');
      const c = other.get('NOT_THIS_ONE');
      const d = configService.get<Array<string>>('HOSTS');
    `;
    expect(callKeys(src, ['configService.get'])).toEqual(['DATABASE_URL', 'REDIS_URL', 'HOSTS']);
    // a plain name matches a method of that name on anything, like the regex form did
    expect(callKeys(src, ['get'])).toEqual(['DATABASE_URL', 'REDIS_URL', 'NOT_THIS_ONE', 'HOSTS']);
  });

  test('a comparison is not mistaken for a generic call', () => {
    expect(callKeys("if (a.get < b && c > ('NOPE')) {}", ['get'])).toEqual([]);
  });

  test('a quote inside a regex literal or a JSX apostrophe does not swallow later code', () => {
    expect(callKeys(outdent`
      const re = /it's ["']quoted/g;
      const x = a / b; requireEnv('AFTER_DIVISION');
      const el = <p>Don't do this</p>;
      const y = requireEnv('AFTER_JSX');
    `, names)).toEqual(['AFTER_DIVISION', 'AFTER_JSX']);
  });

  test('reports the position of the callee', () => {
    const src = 'x;\n  config.get("KEY")';
    const [found] = extractCallKeys(tokenizeSource(src, 'js-like'), ['config.get']);
    expect(found).toEqual({ key: 'KEY', index: src.indexOf('config') });
  });

  test('works on python, with # comments and triple-quoted strings', () => {
    expect(callKeys(outdent`
      # require_env("COMMENTED")
      DOC = """
      require_env("IN_DOCSTRING")
      """
      url = require_env("DATABASE_URL")
      f = require_env(f"{prefix}_X")
    `, ['require_env'], 1, 'python')).toEqual(['DATABASE_URL']);
  });

  test('works on a file type the scanner has no language for', () => {
    const tokens = tokenizeSource('# cfg.get("COMMENTED")\nvalue = cfg.get("TF_KEY")\n', undefined);
    expect(extractCallKeys(tokens, ['cfg.get']).map((k) => k.key)).toEqual(['TF_KEY']);
  });

  test('is linear on a long unbalanced file', () => {
    const src = `${"requireEnv(('A', ".repeat(20_000)}`;
    const started = performance.now();
    expect(callKeys(src, names)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('props=', () => {
  test('finds `name: "KEY"` and `name = "KEY"`', () => {
    // real case: @auditExtraPatterns(regex('credentialName:\s*"([A-Z_]+)"'), fileTypes=[ts])
    expect(propKeys(outdent`
      export const github = defineTool({
        credentialName: "GITHUB_TOKEN",
      });
      export const slack = defineTool({ credentialName : 'SLACK_TOKEN' });
      tool.credentialName = "OPENAI_API_KEY";
      const json = { "credentialName": "QUOTED_KEY" };
    `, ['credentialName'])).toEqual(['GITHUB_TOKEN', 'SLACK_TOKEN', 'OPENAI_API_KEY', 'QUOTED_KEY']);
  });

  test('skips comparisons, types, non-literals, comments and strings', () => {
    expect(propKeys(outdent`
      if (tool.credentialName === "COMPARED") {}
      if (tool.credentialName == "LOOSE") {}
      type T = { credentialName: string };
      const a = { credentialName: getName() };
      const b = { credentialName: \`TEMPLATE_\${x}\` };
      // credentialName: "COMMENTED"
      const c = "credentialName: \\"IN_STRING\\"";
      const d = { otherName: "OTHER" };
    `, ['credentialName'])).toEqual([]);
  });

  test('several on one line', () => {
    expect(propKeys('[{ credentialName: "A_KEY" }, { credentialName: "B_KEY" }]', ['credentialName'])).toEqual(['A_KEY', 'B_KEY']);
  });
});

test('isEnvKeyName', () => {
  expect(['API_KEY', '_X', 'lower_ok', 'A1'].every(isEnvKeyName)).toBe(true);
  expect(['', '1A', 'A-B', 'A.B', 'A B', 'É'].some(isEnvKeyName)).toBe(false);
});
