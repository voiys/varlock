/*
  String rules on the string, url and domain types: startsWith/endsWith (one or a list),
  notStartsWith/notEndsWith/contains/notContains, and chars. They cover what schemas
  used `matches` regexes for, with plain string operations.
*/

import { describe, it, expect } from 'vitest';
import { outdent } from 'outdent';
import { DotEnvFileDataSource, EnvGraph } from '../index';

async function loadAndResolve(envFileContent: string, header = '') {
  const g = new EnvGraph();
  await g.setRootDataSource(new DotEnvFileDataSource('.env.schema', {
    overrideContents: outdent`
      # @defaultRequired=false @defaultSensitive=false ${header}
      # ---
      ${envFileContent}
    `,
  }));
  await g.finishLoad();
  await g.resolveEnvValues();
  return g;
}

const registry = () => new EnvGraph().dataTypesRegistry;

/** the error messages from validating `val`, or [] when it passes */
function check(type: 'string' | 'url' | 'domain', settings: Record<string, any>, val: string): Array<string> {
  const instance = registry()[type](settings);
  const coerced = instance.coerce(val);
  let result: any;
  try {
    result = instance.validate(coerced);
  } catch (err) {
    return [(err as Error).message];
  }
  if (result === true || result === undefined) return [];
  return (Array.isArray(result) ? result : [result])
    .filter((e: any) => !e.isWarning)
    .map((e: Error) => e.message);
}

describe('string rules', () => {
  describe('startsWith / endsWith', () => {
    it('keeps the single-string form and its message', () => {
      expect(check('string', { startsWith: 'pk_' }, 'pk_123')).toEqual([]);
      expect(check('string', { startsWith: 'pk_' }, 'sk_123')).toEqual(['Value must start with "pk_"']);
      expect(check('string', { endsWith: '/' }, 'a/')).toEqual([]);
      expect(check('string', { endsWith: '/' }, 'a')).toEqual(['Value must end with "/"']);
    });

    it('passes when any entry of a list matches', () => {
      const settings = { startsWith: ['24.', 'v24.'] };
      expect(check('string', settings, '24.1.0')).toEqual([]);
      expect(check('string', settings, 'v24.11.1')).toEqual([]);
      expect(check('string', settings, 'v22.1.0')).toEqual(['Value must start with one of "24.", "v24."']);
      expect(check('string', { endsWith: ['.com', '.org'] }, 'a.net')).toEqual(['Value must end with one of ".com", ".org"']);
    });
  });

  describe('notStartsWith / notEndsWith', () => {
    it('fails when the value starts or ends with the string', () => {
      expect(check('string', { notStartsWith: '0' }, '012')).toEqual(['Value must not start with "0"']);
      expect(check('string', { notStartsWith: '0' }, '120')).toEqual([]);
      expect(check('string', { notEndsWith: '/' }, 'a/')).toEqual(['Value must not end with "/"']);
      expect(check('string', { notEndsWith: '/' }, 'a')).toEqual([]);
    });

    it('fails when any entry of a list matches, naming that entry', () => {
      const settings = { notStartsWith: ['http://example.convex.', 'https://example.convex.'] };
      expect(check('url', settings, 'https://example.convex.cloud')).toEqual(['URL must not start with "https://example.convex."']);
      expect(check('url', settings, 'https://happy-otter-123.convex.cloud')).toEqual([]);
      expect(check('string', { notEndsWith: ['.tmp', '.bak'] }, 'x.bak')).toEqual(['Value must not end with ".bak"']);
    });
  });

  describe('contains / notContains', () => {
    it('contains with a list requires every entry', () => {
      const settings = { contains: ['@', '.'] };
      expect(check('string', settings, 'a@b.c')).toEqual([]);
      expect(check('string', settings, 'ab.c')).toEqual(['Value must contain "@"']);
      expect(check('string', settings, 'abc')).toEqual(['Value must contain "@"', 'Value must contain "."']);
    });

    it('notContains with a list rejects every entry', () => {
      expect(check('string', { notContains: '?' }, 'smtp://h:587')).toEqual([]);
      expect(check('string', { notContains: '?' }, 'smtp://h?tls=1')).toEqual(['Value must not contain "?"']);
      expect(check('string', { notContains: [' ', '\t'] }, 'a b')).toEqual(['Value must not contain " "']);
    });
  });

  describe('chars', () => {
    it.each([
      ['digits', '0123456789', '12a', 'Value must only contain digits (0-9), found "a" at position 3'],
      ['hex', 'deadBEEF09', 'cafeg', 'Value must only contain hex digits (0-9, a-f, A-F), found "g" at position 5'],
      ['lowercase', 'abcxyz', 'abC', 'Value must only contain lowercase letters (a-z), found "C" at position 3'],
      ['uppercase', 'ABCXYZ', 'Abc', 'Value must only contain uppercase letters (A-Z), found "b" at position 2'],
      ['letters', 'abcXYZ', 'ab1', 'Value must only contain letters (a-z, A-Z), found "1" at position 3'],
      ['alphanumeric', 'abc123XYZ', 'abc_1', 'Value must only contain letters and digits, found "_" at position 4'],
      ['base64', 'aGVsbG8+/w==', 'aGVs-bG8', 'Value must only contain base64 characters (A-Z, a-z, 0-9, +, /, =), found "-" at position 5'],
      ['base64url', 'aGVsbG8-_w', 'aGVs=', 'Value must only contain base64url characters (A-Z, a-z, 0-9, -, _), found "=" at position 5'],
    ])('preset %s', (preset, good, bad, message) => {
      expect(check('string', { chars: preset }, good)).toEqual([]);
      expect(check('string', { chars: preset }, bad)).toEqual([message]);
    });

    it('mixes presets and literal characters in a list', () => {
      const settings = { chars: ['digits', '-', 'v'] };
      expect(check('string', settings, 'v2025-01-01')).toEqual([]);
      expect(check('string', settings, '2025/01/01')).toEqual(['Value must only contain digits (0-9) and "-", "v", found "/" at position 5']);
      expect(check('string', { chars: ['01'] }, '0110')).toEqual([]);
      expect(check('string', { chars: ['01'] }, '012')).toEqual(['Value must only contain "0", "1", found "2" at position 3']);
    });

    it('an empty value passes', () => {
      expect(check('string', { chars: 'digits' }, '')).toEqual([]);
      expect(check('string', { chars: ['01'] }, '')).toEqual([]);
    });

    it('names whitespace and counts positions by character', () => {
      expect(check('string', { chars: 'letters' }, 'ab c')).toEqual(['Value must only contain letters (a-z, A-Z), found " " at position 3']);
      expect(check('string', { chars: 'letters' }, '😀a!')).toEqual(['Value must only contain letters (a-z, A-Z), found "😀" at position 1']);
      expect(check('string', { chars: ['😀a'] }, 'a😀!')).toEqual(['Value must only contain "😀", "a", found "!" at position 3']);
    });

    it('a lone string must be a preset name', () => {
      expect(check('string', { chars: 'hexx' }, 'abc')[0]).toContain('chars: unknown preset "hexx"');
      expect(check('string', { chars: [] }, 'abc')).toEqual(['chars must not be an empty list']);
      expect(check('string', { chars: 5 }, 'abc')[0]).toContain('chars must be a preset name');
    });
  });

  describe('empty values and bad settings', () => {
    it('empty strings and lists set no rule', () => {
      expect(check('string', { startsWith: '', notContains: [] }, 'anything')).toEqual([]);
      expect(check('string', { startsWith: [], endsWith: [''] }, 'anything')).toEqual([]);
    });

    it('rules are checked against an empty value too', () => {
      expect(check('string', { notStartsWith: '0', notContains: '?' }, '')).toEqual([]);
      expect(check('string', { startsWith: 'a' }, '')).toEqual(['Value must start with "a"']);
    });

    it('a non-string rule value is an error that points at quoting', () => {
      expect(check('string', { notStartsWith: 0 }, '1')).toEqual(['notStartsWith must be a string or an array of strings (quote values that look like numbers, e.g. notStartsWith="0")']);
      expect(check('string', { contains: [1, 'a'] }, 'a')[0]).toContain('contains must be a string or an array of strings');
    });
  });

  it('reports every failed rule', () => {
    expect(check('string', {
      startsWith: 'a', endsWith: 'z', notContains: 'x', chars: 'lowercase',
    }, 'bxY')).toEqual([
      'Value must start with "a"',
      'Value must end with "z"',
      'Value must not contain "x"',
      'Value must only contain lowercase letters (a-z), found "Y" at position 3',
    ]);
  });

  it('applies to the coerced value', () => {
    expect(check('string', { toUpperCase: true, chars: 'uppercase' }, 'abc')).toEqual([]);
  });

  describe('url and domain', () => {
    it('url checks the full value, after its own checks', () => {
      expect(check('url', { startsWith: 'https://api.' }, 'https://api.example.com')).toEqual([]);
      expect(check('url', { startsWith: 'https://api.' }, 'https://www.example.com')).toEqual(['URL must start with "https://api."']);
      expect(check('url', { contains: '/v1/' }, 'https://a.com/v2/')).toEqual(['URL must contain "/v1/"']);
      expect(check('url', { startsWith: 'https://api.' }, 'not a url')).toEqual(['Invalid URL']);
    });

    it('domain checks the value, after its own checks', () => {
      expect(check('domain', { endsWith: '.example.com' }, 'api.example.com')).toEqual([]);
      expect(check('domain', { endsWith: '.example.com' }, 'api.other.com')).toEqual(['Domain must end with ".example.com"']);
      expect(check('domain', { notStartsWith: 'staging.' }, 'staging.example.com')).toEqual(['Domain must not start with "staging."']);
      expect(check('domain', { chars: ['lowercase', '.'] }, 'api.example.com')).toEqual([]);
      expect(check('domain', { endsWith: '.com' }, 'http://a.com')).toEqual(['Domain must not include a protocol']);
    });
  });

  describe('in a schema', () => {
    it('takes lists, presets and quoted strings', async () => {
      const g = await loadAndResolve(outdent`
        # @type=string(startsWith=["24.", "v24."])
        NODE_GOOD=v24.11.1
        # @type=string(startsWith=["24.", "v24."])
        NODE_BAD=v22.1.0
        # @type=string(chars=[digits, "-"], notStartsWith="-")
        CHARS_GOOD=2025-01-01
        # @type=string(chars=[digits, "-"], notStartsWith="-")
        CHARS_BAD=2025_01_01
        # @type=string(chars=hex, isLength=32)
        HEX=0123456789abcdef0123456789ABCDEF
        # @type=url(notStartsWith=["http://example.convex.", "https://example.convex."])
        CONVEX=https://example.convex.cloud
        # @type=domain(endsWith=".example.com")
        DOMAIN=api.example.com
      `);
      const s = g.configSchema;
      expect(s.NODE_GOOD.isValid).toBe(true);
      expect(s.NODE_GOOD.validationState).toBe('valid');
      expect(s.NODE_BAD.isValid).toBe(false);
      expect(s.NODE_BAD.errors[0].message).toBe('Value must start with one of "24.", "v24."');
      expect(s.CHARS_GOOD.isValid).toBe(true);
      expect(s.CHARS_BAD.errors[0].message).toBe('Value must only contain digits (0-9) and "-", found "_" at position 5');
      expect(s.HEX.isValid).toBe(true);
      expect(s.CONVEX.errors.map((e) => e.message)).toEqual(['URL must not start with "https://example.convex."']);
      expect(s.DOMAIN.isValid).toBe(true);
    });

    it('takes values from other items', async () => {
      const g = await loadAndResolve(outdent`
        PREFIX=sk_
        # @type=string(startsWith=$PREFIX)
        GOOD=sk_123
        # @type=string(startsWith=$PREFIX)
        BAD=pk_123
      `);
      expect(g.configSchema.GOOD.isValid).toBe(true);
      expect(g.configSchema.BAD.errors[0].message).toBe('Value must start with "sk_"');
    });

    it('an unquoted number is reported with the quoted form to use', async () => {
      const g = await loadAndResolve(outdent`
        # @type=string(notStartsWith=0)
        N=12
      `);
      expect(g.configSchema.N.errors[0].message).toContain('e.g. notStartsWith="0"');
    });

    describe('if(forEnv(...)) values', () => {
      async function loadWithEnv(appEnv: string) {
        return loadAndResolve(outdent`
          # @type=enum(dev, production)
          APP_ENV=${appEnv}
          # @type=string(startsWith=if(forEnv(production), "signkey-prod-", undefined))
          SIGNING_KEY=signkey-dev-abc
          # @type=string(notStartsWith=if(forEnv(production), ["sk_test_", "pk_test_"], []))
          STRIPE_KEY=sk_test_123
          # @type=string(chars=if(forEnv(production), hex, [hex, "-"]))
          BUILD_ID=abc-123
        `, '@currentEnv=$APP_ENV');
      }

      it('applies the production rules in production', async () => {
        const g = await loadWithEnv('production');
        expect(g.configSchema.SIGNING_KEY.errors[0].message).toBe('Value must start with "signkey-prod-"');
        expect(g.configSchema.STRIPE_KEY.errors[0].message).toBe('Value must not start with "sk_test_"');
        expect(g.configSchema.BUILD_ID.errors[0].message).toContain('found "-" at position 4');
      });

      it('applies the other branch elsewhere', async () => {
        const g = await loadWithEnv('dev');
        expect(g.configSchema.SIGNING_KEY.isValid).toBe(true);
        expect(g.configSchema.STRIPE_KEY.isValid).toBe(true);
        expect(g.configSchema.BUILD_ID.isValid).toBe(true);
      });
    });
  });

  it('every rule setting is read when the type is created (settings tracing)', () => {
    // tooling discovers a type's settings by handing its factory a recording proxy and
    // running coerce/validate on sample values, so every rule must be read on the way
    for (const typeName of ['string', 'url', 'domain'] as const) {
      const keys = new Set<string>();
      const proxy = new Proxy({}, {
        get(_t, k) {
          if (typeof k === 'string') keys.add(k);
          return undefined;
        },
        has(_t, k) {
          if (typeof k === 'string') keys.add(k);
          return false;
        },
      });
      const instance = registry()[typeName](proxy as any);
      for (const sample of ['', 'abc', 'https://example.com', 'example.com']) {
        try {
          instance.validate(instance.coerce(sample));
        } catch { /* invalid sample */ }
      }
      expect([...keys]).toEqual(expect.arrayContaining(['startsWith', 'endsWith', 'notStartsWith', 'notEndsWith', 'contains', 'notContains', 'chars', 'matches']));
    }
  });
});

/*
  The 18 value checks found in real public schemas, each rewritten as rules. Both forms are
  validated on the same samples (as a `matches` regex and as rules on the same type) and
  must agree. Where rules cannot say exactly what the regex says, the case is marked
  `inexact` with the samples where they differ.
*/
type RealWorldCase = {
  uses: number;
  type: 'string' | 'url';
  regex: RegExp;
  rules: Record<string, any>;
  /** the rules as written in a schema */
  schema: string;
  samples: Array<string>;
  inexact?: { reason: string, differsOn: Array<string> };
};

const b64url = (n: number) => 'aZ09-_'.repeat(Math.ceil(n / 6)).slice(0, n);

const REAL_WORLD_CASES: Array<RealWorldCase> = [
  {
    uses: 3,
    type: 'url',
    regex: /^(?!https?:\/\/example[.]convex[.])/,
    rules: { notStartsWith: ['http://example.convex.', 'https://example.convex.'] },
    schema: 'url(notStartsWith=["http://example.convex.", "https://example.convex."])',
    samples: [
      'https://example.convex.cloud',
      'http://example.convex.site',
      'https://happy-otter-123.convex.cloud',
      'https://example.convexx.cloud',
      'https://my.example.convex.cloud',
      'HTTPS://example.convex.cloud',
    ],
  },
  {
    uses: 1,
    type: 'string',
    regex: /^v?\d{4}-\d{2}-\d{2}$/,
    rules: { chars: ['digits', '-', 'v'], minLength: 10, maxLength: 11 },
    schema: 'string(chars=[digits, "-", "v"], minLength=10, maxLength=11)',
    samples: ['2025-01-01', 'v2025-01-01', '2025-1-01', '2025/01/01', 'x2025-01-01', '2025-01-01x', '20250-1-01', '2025-01-0v', 'v-12345678'],
    inexact: {
      reason: 'rules check which characters appear and the length, not where each one goes: the optional leading "v" and the dash positions cannot be expressed',
      differsOn: ['20250-1-01', '2025-01-0v', 'v-12345678'],
    },
  },
  {
    uses: 1,
    type: 'string',
    regex: /^[a-fA-F0-9]{32}$/,
    rules: { chars: 'hex', isLength: 32 },
    schema: 'string(chars=hex, isLength=32)',
    samples: ['0123456789abcdef0123456789ABCDEF', '0123456789abcdef0123456789ABCDE', '0123456789abcdef0123456789ABCDEG', '0123456789abcdef0123456789ABCDEFF', ''],
  },
  {
    uses: 1,
    type: 'string',
    // `matches=if(forEnv(production), "^signkey-prod-", ".*")` - this is the production branch,
    // the other branch (".*") is no rule at all. The forEnv() form itself is tested above.
    regex: /^signkey-prod-/,
    rules: { startsWith: 'signkey-prod-' },
    schema: 'string(startsWith=if(forEnv(production), "signkey-prod-", undefined))',
    samples: ['signkey-prod-abc', 'signkey-dev-abc', 'xsignkey-prod-', 'signkey-prod-'],
  },
  {
    uses: 3,
    type: 'string',
    regex: /^(|[1-9][0-9]*)$/,
    rules: { chars: 'digits', notStartsWith: '0' },
    schema: 'string(chars=digits, notStartsWith="0")',
    samples: ['', '0', '1', '10', '5000', '007', '12a', '-1', ' 1', '1.5'],
  },
  {
    uses: 1,
    type: 'string',
    regex: /^(|[0-9]+)$/,
    rules: { chars: 'digits' },
    schema: 'string(chars=digits)',
    samples: ['', '0', '0012', '1.5', 'a', '-1'],
  },
  {
    uses: 1,
    type: 'string',
    regex: /^B[A-Za-z0-9_-]{86}$/,
    rules: { startsWith: 'B', chars: 'base64url', isLength: 87 },
    schema: 'string(startsWith="B", chars=base64url, isLength=87)',
    samples: [`B${b64url(86)}`, `C${b64url(86)}`, `B${b64url(85)}`, `B${b64url(85)}=`, `B${b64url(85)}+`, `B${b64url(87)}`],
  },
  {
    uses: 1,
    type: 'string',
    regex: /^[A-Za-z0-9_-]{43}$/,
    rules: { chars: 'base64url', isLength: 43 },
    schema: 'string(chars=base64url, isLength=43)',
    samples: [b64url(43), b64url(42), b64url(44), `${b64url(42)}=`, `${b64url(42)}/`],
  },
  {
    uses: 1,
    type: 'string',
    regex: /^v?24\./,
    rules: { startsWith: ['24.', 'v24.'] },
    schema: 'string(startsWith=["24.", "v24."])',
    samples: ['24.1.0', 'v24.11.1', 'v22.1.0', '24', '224.1', 'v24', '24.', 'vv24.1'],
  },
  {
    uses: 3,
    type: 'string',
    regex: /^[01]$/,
    rules: { chars: ['01'], isLength: 1 },
    schema: 'string(chars=["01"], isLength=1)',
    samples: ['0', '1', '2', '01', '', 'true', ' 1'],
  },
  {
    uses: 1,
    type: 'string',
    regex: /^[^?]*$/,
    rules: { notContains: '?' },
    schema: 'string(notContains="?")',
    samples: ['smtp://user:pass@host:587', 'smtp+tls://host:587', 'smtp://host?tls=1', '', '?'],
  },
  {
    uses: 1,
    type: 'string',
    regex: /^.+\/$/,
    rules: { endsWith: '/', minLength: 2 },
    schema: 'string(endsWith="/", minLength=2)',
    samples: ['/media/', 'https://cdn.example.com/', '/', '/media', 'a/', 'a\n/'],
    inexact: {
      reason: 'the regex `.` rejects line terminators, which rules cannot express in a schema (a type option value has no escape for a newline); exact for single-line values',
      differsOn: ['a\n/'],
    },
  },
];

describe('the 18 real-world value checks, rewritten as rules', () => {
  it('covers all 18 uses', () => {
    expect(REAL_WORLD_CASES.reduce((sum, c) => sum + c.uses, 0)).toBe(18);
    // 16 of the 18 are exact
    expect(REAL_WORLD_CASES.filter((c) => !c.inexact).reduce((sum, c) => sum + c.uses, 0)).toBe(16);
  });

  describe.each(REAL_WORLD_CASES.map((c) => [String(c.regex), c] as const))('%s', (_label, c) => {
    it(`agrees with ${c.schema}${c.inexact ? ' (inexact)' : ''}`, () => {
      for (const sample of c.samples) {
        const regexPasses = check(c.type, { matches: c.regex }, sample).length === 0;
        const rulesPass = check(c.type, c.rules, sample).length === 0;
        if (c.inexact?.differsOn.includes(sample)) {
          expect(rulesPass, `rules and regex should differ on ${JSON.stringify(sample)}`).not.toBe(regexPasses);
        } else {
          expect(rulesPass, `rules and regex should agree on ${JSON.stringify(sample)}`).toBe(regexPasses);
        }
      }
    });

    it('reads the same way from a schema', async () => {
      const samples = c.samples.filter((s) => s !== '' && !s.includes('\n') && !c.inexact?.differsOn.includes(s));
      const lines = [
        '# @type=enum(production)',
        'APP_ENV=production',
        ...samples.flatMap((s, i) => [`# @type=${c.schema}`, `V${i}=${JSON.stringify(s)}`]),
      ];
      const g = await loadAndResolve(lines.join('\n'), '@currentEnv=$APP_ENV');
      samples.forEach((s, i) => {
        const item = g.configSchema[`V${i}`];
        expect(item.isValid, `${c.schema} on ${JSON.stringify(s)}`).toBe(c.regex.test(s));
        // a rule never produces a deprecation warning
        expect(item.errors.filter((e) => e.isWarning)).toEqual([]);
      });
    });
  });
});
