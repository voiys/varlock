import {
  describe, test, expect, vi, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import outdent from 'outdent';
import { EnvGraph, DotEnvFileDataSource } from '../index';

// these cover mistakes found in real schemas, where the old message did not say what to fix

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-schema-errors-test-'));
  vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  // nothing here should reach the npm registry
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network disabled in tests'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadSchema(contents: string) {
  const g = new EnvGraph();
  await g.setRootDataSource(new DotEnvFileDataSource(path.join(tmpDir, '.env.schema'), { overrideContents: contents }));
  await g.finishLoad();
  return g;
}

function sourceErrors(g: EnvGraph) {
  return g.sortedDataSources.flatMap((s) => s.errors).filter((e) => !e.isWarning);
}

describe('@import unknown options', () => {
  test('required=false points to allowMissing=true instead of reporting a missing path', async () => {
    const g = await loadSchema(outdent`
      # @import(./.env.not-here, required=false)
      # ---
      ITEM=foo
    `);
    const errors = sourceErrors(g);
    expect(errors.map((e) => e.message)).toEqual(['@import: unknown option "required". Valid options: enabled, allowMissing, pick, omit']);
    expect(errors[0].tip).toContain('allowMissing=true');
  });

  test('a misspelled option suggests the closest valid one', async () => {
    const g = await loadSchema(outdent`
      # @import(./.env.not-here, allowmissing=true)
      # ---
      ITEM=foo
    `);
    const errors = sourceErrors(g);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('unknown option "allowmissing"');
    expect(errors[0].tip).toBe('Did you mean allowMissing?');
  });

  test('valid options are still accepted', async () => {
    const g = await loadSchema(outdent`
      # @import(./.env.not-here, allowMissing=true, enabled=true)
      # ---
      ITEM=foo
    `);
    expect(sourceErrors(g)).toEqual([]);
  });
});

describe('unknown decorators', () => {
  function itemErrors(g: EnvGraph, key: string) {
    return g.configSchema[key].errors.filter((e) => !e.isWarning);
  }

  test('@description explains where item descriptions come from', async () => {
    const g = await loadSchema(outdent`
      # @description the model to serve
      ITEM=foo
    `);
    const [err] = itemErrors(g, 'ITEM');
    expect(err.message).toBe('Unknown decorator: @description');
    expect(err.tip).toContain('plain comment lines directly above the item');
  });

  test('a misspelled decorator suggests the closest known one', async () => {
    const g = await loadSchema(outdent`
      # @sensitve
      ITEM=foo
    `);
    const [err] = itemErrors(g, 'ITEM');
    expect(err.message).toBe('Unknown decorator: @sensitve');
    expect(err.tip).toContain('Did you mean @sensitive?');
  });

  test('an unrelated name explains how to keep it as plain text', async () => {
    const g = await loadSchema(outdent`
      # @docsExempt
      ITEM=foo
    `);
    const [err] = itemErrors(g, 'ITEM');
    expect(err.message).toBe('Unknown decorator: @docsExempt');
    expect(err.tip).not.toContain('Did you mean');
    expect(err.tip).toContain('does not start with @');
    expect(err.tip).toContain('# note: @docsExempt');
  });

  test('the suggested plain-text form is not read as a decorator', async () => {
    const g = await loadSchema(outdent`
      # note: @docsExempt
      ITEM=foo
    `);
    expect(itemErrors(g, 'ITEM')).toEqual([]);
    expect(g.configSchema.ITEM.description).toBe('note: @docsExempt');
  });
});

describe('parse errors on decorator comment lines', () => {
  test('prose that starts with @ says it was read as a decorator', async () => {
    const g = await loadSchema(outdent`
      # Secrets
      # @secret(exec(./fetch.sh NAME)) entries call a helper
      # ---
      ITEM=foo
    `);
    const [err] = sourceErrors(g);
    expect(err.message).toBe(
      'Parse error on line 2: this comment starts with @, so it is read as a decorator, but it could not be parsed'
      + ' (Expected "#", ")", ",", "\\n", or [ \\t] but "N" found.)',
    );
    expect(err.location?.lineNumber).toBe(2);
    expect(err.tip).toContain('quote');
    expect(err.tip).toContain('does not start with @');
  });

  test('other parse errors keep the parser message', async () => {
    const g = await loadSchema(outdent`
      ITEM=foo
      NO_EQUALS
    `);
    const [err] = sourceErrors(g);
    expect(err.message).toMatch(/^Parse error: Expected /);
    expect(err.tip).toBeUndefined();
  });
});

describe('plugin version mismatch', () => {
  test('names both versions and how to fix it', async () => {
    const pluginDir = path.join(tmpDir, 'node_modules', '@varlock', 'test-plugin');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: '@varlock/test-plugin', version: '2.0.0' }));

    const g = await loadSchema(outdent`
      # @plugin(@varlock/test-plugin@1.2.3)
      # ---
      ITEM=foo
    `);
    const [err] = g.rootDataSource!.getRootDecFns('plugin')[0]._errors;
    expect(err.message).toBe(
      'Plugin "@varlock/test-plugin" version mismatch: @plugin() asks for "1.2.3", but the installed version is "2.0.0"'
      + ` (found in ${pluginDir})`,
    );
    expect(err.tip).toContain('@plugin(@varlock/test-plugin@2.0.0)');
    expect(err.tip).toContain('"@varlock/test-plugin": "1.2.3"');
  });
});
