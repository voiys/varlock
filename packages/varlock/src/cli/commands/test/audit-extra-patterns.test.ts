import {
  afterEach, beforeEach, describe, expect, test, vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { commandFn } from '../audit.command';

const {
  gracefulExitMock,
  scanCodeForEnvVarsMock,
} = vi.hoisted(() => ({
  gracefulExitMock: vi.fn(),
  scanCodeForEnvVarsMock: vi.fn(),
}));
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

// Only the process boundary (exit) and the scanner input are faked: the
// schema text goes through the real parser, decorator resolution and command
// wiring. This is the seam a mocked dec.resolve() cannot cover, and it is what
// let the first draft document a form the parser rejects.
vi.mock('exit-hook', () => ({ gracefulExit: gracefulExitMock }));
// only the scan itself is faked; exclusion normalization is pure logic the command
// should exercise for real
vi.mock('../../helpers/env-var-scanner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../helpers/env-var-scanner')>()),
  scanCodeForEnvVars: scanCodeForEnvVarsMock,
}));

describe('audit @auditExtraPatterns end to end', () => {
  let tempDir: string;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    gracefulExitMock.mockReset();
    scanCodeForEnvVarsMock.mockReset();

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-audit-extra-'));
    fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.env.schema'), [
      // NOTE: inner quotes must be backslash-escaped; a bare '...' inside
      // would terminate the DSL string and fail parsing outright.
      '# @auditExtraPatterns(regex(\'config\\.get\\(\\s*\\\'([A-Z_]+)\\\'\\)\'))',
      '# ---',
      'APP_ID=',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(tempDir, '.env'), 'APP_ID=abc\n');
    fs.writeFileSync(path.join(tempDir, 'config', 'app.ts'), 'const id = config.get(\'APP_ID\');\n');
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('documented regex() form reaches the scanner as a usable regex', async () => {
    scanCodeForEnvVarsMock.mockResolvedValue({
      keys: ['APP_ID'],
      references: [],
      scannedFilesCount: 1,
    });

    await commandFn({ values: { path: tempDir } } as any);

    expect(scanCodeForEnvVarsMock).toHaveBeenCalledTimes(1);
    const options = scanCodeForEnvVarsMock.mock.calls[0]?.[0] as
      | { extraPatterns?: Array<{ pattern: RegExp, fileTypes?: Array<string> }> }
      | undefined;
    expect(options?.extraPatterns).toHaveLength(1);
    // Single backslashes at runtime: the DSL unescaped \' but kept \. \( \s.
    expect(options?.extraPatterns?.[0]?.pattern.source).toBe('config\\.get\\(\\s*\'([A-Z_]+)\'\\)');
    expect(options?.extraPatterns?.[0]?.fileTypes).toBeUndefined();
    expect(gracefulExitMock).toHaveBeenCalledWith(0);
  });

  test('documented fileTypes=[...] form reaches the scanner scoped to its own call', async () => {
    fs.writeFileSync(path.join(tempDir, '.env.schema'), [
      '# @auditExtraPatterns(regex(\'cfg\\.get\\(\\s*"([A-Z_]+)"\\)\'), fileTypes=[tf, yaml])',
      '# ---',
      'APP_ID=',
      '',
    ].join('\n'));

    scanCodeForEnvVarsMock.mockResolvedValue({
      keys: ['APP_ID'],
      references: [],
      scannedFilesCount: 1,
    });

    await commandFn({ values: { path: tempDir } } as any);

    const options = scanCodeForEnvVarsMock.mock.calls[0]?.[0] as
      | { extraPatterns?: Array<{ pattern: RegExp, fileTypes?: Array<string> }> }
      | undefined;
    expect(options?.extraPatterns).toHaveLength(1);
    expect(options?.extraPatterns?.[0]?.fileTypes).toEqual(['tf', 'yaml']);
    expect(gracefulExitMock).toHaveBeenCalledWith(0);
  });

  test('documented regex() form gets a deprecation warning naming calls=/props=', async () => {
    scanCodeForEnvVarsMock.mockResolvedValue({ keys: ['APP_ID'], references: [], scannedFilesCount: 1 });

    await commandFn({ values: { path: tempDir } } as any);

    const printed = consoleErrorSpy.mock.calls.map((args: Array<unknown>) => args.join(' ')).join('\n');
    expect(printed).toContain('@auditExtraPatterns(): regex patterns are deprecated, use calls=[...] or props=[...] instead');
    expect(gracefulExitMock).toHaveBeenCalledWith(0);
  });

  // the three regex forms found in real schemas, rewritten
  test.each([
    {
      decorator: '@auditExtraPatterns(calls=[requireEnv, requireStrongSecret, isFlagEnabled])',
      expected: { calls: ['requireEnv', 'requireStrongSecret', 'isFlagEnabled'] },
    },
    {
      decorator: '@auditExtraPatterns(props=[credentialName], fileTypes=[ts])',
      expected: { props: ['credentialName'], fileTypes: ['ts'] },
    },
    {
      decorator: '@auditExtraPatterns(calls=[setting, choice, integer, positiveNumber], arg=2, fileTypes=[ts])',
      expected: { calls: ['setting', 'choice', 'integer', 'positiveNumber'], arg: 2, fileTypes: ['ts'] },
    },
    {
      decorator: '@auditExtraPatterns(calls=[configService.get], props=[envKey])',
      expected: [{ calls: ['configService.get'] }, { props: ['envKey'] }],
    },
  ])('$decorator reaches the scanner', async ({ decorator, expected }) => {
    fs.writeFileSync(path.join(tempDir, '.env.schema'), [`# ${decorator}`, '# ---', 'APP_ID=', ''].join('\n'));
    scanCodeForEnvVarsMock.mockResolvedValue({ keys: ['APP_ID'], references: [], scannedFilesCount: 1 });

    await commandFn({ values: { path: tempDir } } as any);

    const options = scanCodeForEnvVarsMock.mock.calls[0]?.[0] as { extraPatterns?: Array<unknown> } | undefined;
    expect(options?.extraPatterns).toEqual(Array.isArray(expected) ? expected : [expected]);
    // no deprecation warning for the new forms
    const printed = consoleErrorSpy.mock.calls.map((args: Array<unknown>) => args.join(' ')).join('\n');
    expect(printed).not.toContain('deprecated');
    expect(gracefulExitMock).toHaveBeenCalledWith(0);
  });

  test.each([
    ['@auditExtraPatterns(arg=2)', 'arg=N only applies to calls=[...]'],
    ['@auditExtraPatterns(calls=[f], arg=0)', 'arg must be a whole number of 1 or more'],
    ['@auditExtraPatterns(calls=[f], arg=two)', 'arg must be a whole number of 1 or more'],
    ['@auditExtraPatterns(calls=["not a name"])', 'calls=[...] has an invalid name "not a name"'],
    ['@auditExtraPatterns(props=[a.b])', 'props=[...] has an invalid name "a.b"'],
    ['@auditExtraPatterns(calls=[])', 'calls=[...] cannot be empty'],
    ['@auditExtraPatterns(fileTypes=[ts])', 'nothing to look for'],
    ['@auditExtraPatterns(call=[f])', 'unknown option "call"'],
  ])('%s is rejected', async (decorator, message) => {
    fs.writeFileSync(path.join(tempDir, '.env.schema'), [`# ${decorator}`, '# ---', 'APP_ID=', ''].join('\n'));
    await expect(commandFn({ values: { path: tempDir } } as any)).rejects.toThrow(message);
    expect(scanCodeForEnvVarsMock).not.toHaveBeenCalled();
  });
});
