import {
  afterAll, describe, expect, test,
} from 'vitest';
import outdent from 'outdent';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';

import {
  collectTypeGenItems, generateTsTypesSrc, resolveFieldType, resolveFieldTypes,
} from '../../index';
import { getTypeGenInfoMap, loadGraph } from './helpers';

// the real runtime module, so the global `varlock/env` augmentation is checked against the actual
// declaration of `ENV` (not a stub)
const VARLOCK_ENV_SRC = path.resolve(__dirname, '../../../runtime/env.ts');

const tmpDirs: Array<string> = [];
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Generate types for `schema` (through the real `@generateTsTypes` decorator), then typecheck
 * `checkSrc` against them with tsc. Returns the diagnostics for `checkSrc` only, so an unused
 * `@ts-expect-error` shows up as an error too.
 */
async function generateAndTypecheck(opts: {
  schema: string;
  checkSrc: string;
  outputFile?: string;
  strict?: boolean;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-narrow-by-env-'));
  tmpDirs.push(dir);
  const outputFile = opts.outputFile ?? 'env.d.ts';
  // quoted, with forward slashes, so temp paths with spaces or backslashes (Windows) still parse
  const outputPath = path.join(dir, outputFile).split(path.sep).join('/');
  const g = await loadGraph({
    envFile: opts.schema.replace('OUTPUT_PATH', JSON.stringify(outputPath)),
  });
  await g.runCodeGeneratorsIfNeeded();
  const generated = fs.readFileSync(path.join(dir, outputFile), 'utf-8');

  const checkFile = path.join(dir, 'check.ts');
  fs.writeFileSync(checkFile, opts.checkSrc);
  const program = ts.createProgram({
    rootNames: [path.join(dir, outputFile), checkFile],
    options: {
      noEmit: true,
      ...opts.strict === false ? {} : { strict: true },
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      types: [],
      paths: { 'varlock/env': [VARLOCK_ENV_SRC] },
    },
  });
  const sourceFile = program.getSourceFile(checkFile)!;
  const errors = [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ].map((d) => {
    const { line } = d.file!.getLineAndCharacterOfPosition(d.start!);
    return `check.ts:${line + 1} TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
  });
  return { generated, errors };
}

// the example from https://github.com/dmno-dev/varlock/issues/850
const ISSUE_SCHEMA = outdent`
  # @currentEnv=$APP_ENV
  # @generateTsTypes(path=OUTPUT_PATH, narrowByEnv=true)
  # ---
  # @type=enum(dev, staging, prod, building)
  APP_ENV=dev
  # @optional=forEnv(building)
  DATABASE_PASSWORD=
  # @required=forEnv(prod)
  SENTRY_DSN=
  # @optional
  ALWAYS_OPTIONAL=
  ALWAYS_REQUIRED=foo
`;

describe('@generateTsTypes narrowByEnv', () => {
  describe('requiredness analysis', () => {
    test('forEnv() with static args records which envs make the item required', async () => {
      const g = await loadGraph({ envFile: ISSUE_SCHEMA.replace('OUTPUT_PATH', 'unused.d.ts') });
      const infos = await getTypeGenInfoMap(g);
      expect(infos.DATABASE_PASSWORD.requiredByEnv).toEqual({
        envFlagKey: 'APP_ENV', matchEnvs: ['building'], requiredWhenMatched: false,
      });
      expect(infos.SENTRY_DSN.requiredByEnv).toEqual({
        envFlagKey: 'APP_ENV', matchEnvs: ['prod'], requiredWhenMatched: true,
      });
      // static requiredness is not env-dependent
      expect(infos.ALWAYS_OPTIONAL.requiredByEnv).toBeUndefined();
      expect(infos.ALWAYS_REQUIRED.requiredByEnv).toBeUndefined();
      // the base types are unchanged: env-dependent items stay optional there
      expect(resolveFieldType(infos.DATABASE_PASSWORD).isRequired).toBe(false);
    });

    test('anything not purely env-based stays dynamic', async () => {
      const g = await loadGraph({
        envFile: outdent`
          # @currentEnv=$APP_ENV
          # ---
          # @type=enum(dev, prod)
          APP_ENV=dev
          OTHER_ENV=prod
          # @required=forEnv($OTHER_ENV)
          REF_ARG=
          # @required=eq($APP_ENV, prod)
          EQ_CHECK=
          # @required=not(forEnv(dev))
          NESTED=
        `,
      });
      const infos = await getTypeGenInfoMap(g);
      for (const key of ['REF_ARG', 'EQ_CHECK', 'NESTED']) {
        expect(infos[key].isRequiredDynamic).toBe(true);
        expect(infos[key].requiredByEnv).toBeUndefined();
      }
    });

    test('items imported from another file use the root env flag, unless that schema sets its own', async () => {
      const g = await loadGraph({
        files: {
          '.env.schema': outdent`
            # @currentEnv=$APP_ENV
            # @import(./.env.shared)
            # @import(./other/)
            # ---
            # @type=enum(dev, prod)
            APP_ENV=dev
          `,
          '.env.shared': outdent`
            # @required=forEnv(prod)
            SHARED_ITEM=
          `,
          'other/.env.schema': outdent`
            # @currentEnv=$OTHER_ENV
            # ---
            # @type=enum(dev, prod)
            OTHER_ENV=dev
            # @required=forEnv(prod)
            OTHER_ITEM=
          `,
        },
      });
      const infos = await getTypeGenInfoMap(g);
      expect(infos.SHARED_ITEM.requiredByEnv).toEqual({
        envFlagKey: 'APP_ENV', matchEnvs: ['prod'], requiredWhenMatched: true,
      });
      // forEnv() there checks OTHER_ENV, so APP_ENV says nothing about it
      expect(infos.OTHER_ITEM.isRequiredDynamic).toBe(true);
      expect(infos.OTHER_ITEM.requiredByEnv).toBeUndefined();
    });
  });

  describe('generated output', () => {
    test('does not depend on the current env or env-specific files', async () => {
      const outputs = new Set<string>();
      for (const env of ['dev', 'prod', 'building']) {
        const g = await loadGraph({
          overrideValues: { APP_ENV: env },
          files: {
            '.env.schema': ISSUE_SCHEMA.replace('# @generateTsTypes(path=OUTPUT_PATH, narrowByEnv=true)\n', ''),
            // env-specific files are not part of the generated types
            '.env.prod': outdent`
              # @optional
              SENTRY_DSN=
            `,
            '.env.building': outdent`
              # @required
              ALWAYS_OPTIONAL=
            `,
          },
        });
        const fields = resolveFieldTypes(await collectTypeGenItems(g));
        outputs.add(await generateTsTypesSrc(fields, { envFlagKey: 'APP_ENV', narrowByEnv: true, icons: false }));
      }
      expect(outputs.size).toBe(1);
      const [src] = outputs;
      expect(src).toContain('readonly APP_ENV: "prod"; readonly DATABASE_PASSWORD: NonNullable<CoercedEnvSchema["DATABASE_PASSWORD"]>; readonly SENTRY_DSN:');
      expect(src).not.toContain('readonly ALWAYS_OPTIONAL:');
    });

    test('is unchanged unless the option is set', async () => {
      const g = await loadGraph({ envFile: ISSUE_SCHEMA.replace('OUTPUT_PATH', 'unused.d.ts') });
      const fields = resolveFieldTypes(Object.values(await getTypeGenInfoMap(g)));
      const src = await generateTsTypesSrc(fields, { envFlagKey: 'APP_ENV' });
      expect(src).not.toContain('CoercedEnvSchemaByEnv');
      expect(src).not.toContain('TypedEnvByEnv');
    });

    test('envs with the same required items share one union member', async () => {
      const { generated } = await generateAndTypecheck({ schema: ISSUE_SCHEMA, checkSrc: '' });
      expect(generated).toContain('export type CoercedEnvSchemaByEnv =');
      expect(generated).toContain('readonly APP_ENV: "dev" | "staging"; readonly DATABASE_PASSWORD: NonNullable<CoercedEnvSchema["DATABASE_PASSWORD"]> })');
      expect(generated).toContain('readonly APP_ENV: "prod"; readonly DATABASE_PASSWORD: NonNullable<CoercedEnvSchema["DATABASE_PASSWORD"]>; readonly SENTRY_DSN: NonNullable<CoercedEnvSchema["SENTRY_DSN"]> })');
      expect(generated).toContain('readonly APP_ENV: "building" })');
      expect(generated).toMatch(/export interface TypedEnvByEnv \{ env: _CoercedEnvSchemaByEnv_[0-9a-f]+ \}/);
    });

    test('rejects schemas it cannot narrow', async () => {
      const cases: Array<[string, string]> = [
        [
          outdent`
          # @generateTsTypes(path=unused.d.ts, narrowByEnv=true)
          # ---
          ITEM=foo
        `, 'needs @currentEnv to be set',
        ],
        [
          outdent`
          # @currentEnv=$APP_ENV
          # @generateTsTypes(path=unused.d.ts, narrowByEnv=true)
          # ---
          APP_ENV=dev
        `, 'to be an enum',
        ],
        [
          outdent`
          # @currentEnv=$APP_ENV
          # @generateTsTypes(path=unused.d.ts, narrowByEnv=true, filter=ITEM)
          # ---
          # @type=enum(dev, prod)
          APP_ENV=dev
          ITEM=foo
        `, 'excluded by `filter`',
        ],
      ];
      for (const [envFile, message] of cases) {
        const g = await loadGraph({ envFile });
        await expect(g.runCodeGeneratorsIfNeeded()).rejects.toThrow(message);
      }
    });
  });

  // tsc checks of code using the generated types, with @ts-expect-error marking what must NOT compile
  describe('typechecking', () => {
    test('global ENV from varlock/env narrows when checking the env flag', async () => {
      const { errors } = await generateAndTypecheck({
        schema: ISSUE_SCHEMA,
        checkSrc: outdent`
          import { ENV } from 'varlock/env';

          if (ENV.APP_ENV !== 'building') {
            const pw: string = ENV.DATABASE_PASSWORD;
            // @ts-expect-error only required in prod
            const dsn: string = ENV.SENTRY_DSN;
          } else {
            // @ts-expect-error optional while building
            const pw: string = ENV.DATABASE_PASSWORD;
          }
          if (ENV.APP_ENV === 'prod') {
            const dsn: string = ENV.SENTRY_DSN;
          }
          // @ts-expect-error not narrowed outside a check
          const pw: string = ENV.DATABASE_PASSWORD;
          // @ts-expect-error statically optional items never narrow
          const opt: string = ENV.ALWAYS_OPTIONAL;
          const req: string = ENV.ALWAYS_REQUIRED;
          // @ts-expect-error ENV stays read-only
          ENV.ALWAYS_REQUIRED = 'x';
          // @ts-expect-error not a valid env
          if (ENV.APP_ENV === 'nope') {}
          // keys merged in by another generated file (e.g. another package in a monorepo) stay typed
          const other: string = ENV.OTHER_PKG_ITEM;

          declare module 'varlock/env' {
            interface TypedEnvSchema { readonly OTHER_PKG_ITEM: string }
          }
        `,
      });
      expect(errors).toEqual([]);
    }, 30_000);

    test('without the option, ENV keeps its plain type', async () => {
      const { errors } = await generateAndTypecheck({
        schema: ISSUE_SCHEMA.replace(', narrowByEnv=true', ''),
        checkSrc: outdent`
          import { ENV } from 'varlock/env';

          if (ENV.APP_ENV !== 'building') {
            // @ts-expect-error not narrowed without narrowByEnv
            const pw: string = ENV.DATABASE_PASSWORD;
          }
          const req: string = ENV.ALWAYS_REQUIRED;
        `,
      });
      expect(errors).toEqual([]);
    }, 30_000);

    test('exposeEnv=local exports a narrowed ENV', async () => {
      const { errors } = await generateAndTypecheck({
        schema: ISSUE_SCHEMA.replace('narrowByEnv=true', 'narrowByEnv=true, exposeEnv=local'),
        outputFile: 'env.ts',
        checkSrc: outdent`
          import { ENV } from './env.ts';

          if (ENV.APP_ENV !== 'building') {
            const pw: string = ENV.DATABASE_PASSWORD;
          } else {
            // @ts-expect-error optional while building
            const pw: string = ENV.DATABASE_PASSWORD;
          }
        `,
      });
      expect(errors).toEqual([]);
    }, 30_000);

    test('an optional env flag keeps a member where nothing is narrowed', async () => {
      const { errors } = await generateAndTypecheck({
        schema: ISSUE_SCHEMA.replace('APP_ENV=dev', 'APP_ENV= # @optional'),
        checkSrc: outdent`
          import { ENV } from 'varlock/env';

          if (ENV.APP_ENV !== 'building') {
            // @ts-expect-error APP_ENV may be unset, so this branch includes undefined
            const pw: string = ENV.DATABASE_PASSWORD;
          }
          if (ENV.APP_ENV === 'dev') {
            const pw: string = ENV.DATABASE_PASSWORD;
          }
        `,
      });
      expect(errors).toEqual([]);
    }, 30_000);

    test('compiles without strictNullChecks', async () => {
      const { errors } = await generateAndTypecheck({
        schema: ISSUE_SCHEMA,
        strict: false,
        checkSrc: outdent`
          import { ENV } from 'varlock/env';

          if (ENV.APP_ENV !== 'building') {
            const pw: string = ENV.DATABASE_PASSWORD;
          }
          const env: 'dev' | 'staging' | 'prod' | 'building' = ENV.APP_ENV;
        `,
      });
      expect(errors).toEqual([]);
    }, 30_000);
  });
});
