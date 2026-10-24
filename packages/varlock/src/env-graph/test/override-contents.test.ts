import {
  describe, it, expect, beforeAll, afterAll,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EnvGraph, DotEnvFileDataSource } from '../index';

describe('DotEnvFileDataSource overrideContents', () => {
  let tmpDir: string;
  let existingFile: string;
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-override-contents-'));
    existingFile = path.join(tmpDir, '.env.schema');
    fs.writeFileSync(existingFile, 'FROM_DISK=disk-value\n');
  });
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function load(filePath: string, opts?: { overrideContents?: string }) {
    const g = new EnvGraph();
    const source = new DotEnvFileDataSource(filePath, opts);
    await g.setRootDataSource(source);
    await g.finishLoad();
    return { g, source };
  }

  it('reads the file from disk when no override is given', async () => {
    const { g, source } = await load(existingFile);
    expect(source.rawContents).toBe('FROM_DISK=disk-value\n');
    expect(Object.keys(g.configSchema)).toEqual(['FROM_DISK']);
  });

  it('uses an empty string override instead of reading the file from disk', async () => {
    const { g, source } = await load(existingFile, { overrideContents: '' });
    expect(source.rawContents).toBe('');
    expect(source.loadingError).toBeUndefined();
    expect(Object.keys(g.configSchema)).toEqual([]);
  });

  it('does not report a missing file when an empty string override is given', async () => {
    const missingFile = path.join(tmpDir, 'does-not-exist', '.env.schema');
    const { source } = await load(missingFile, { overrideContents: '' });
    expect(source.rawContents).toBe('');
    expect(source.loadingError).toBeUndefined();
  });

  it('still reports a missing file when no override is given', async () => {
    const missingFile = path.join(tmpDir, 'does-not-exist', '.env.schema');
    const { source } = await load(missingFile);
    expect(source.loadingError?.message).toMatch(/File does not exist/);
  });
});
