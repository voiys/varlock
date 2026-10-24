import {
  describe, test, expect, vi, beforeEach, afterEach,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import outdent from 'outdent';
import { commandFn } from '../codegen.command';
import { loadVarlockEnvGraph } from '../../../lib/load-graph';

// `varlock codegen` must not run anything a schema asks for. Each side-effect test has a positive
// control: the same schema through a full load (what `varlock load` does) performs the side effect,
// so a passing test can't come from a probe that never fires.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-codegen-'));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), contents);
  }
}

const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf-8');

async function codegen(fn: typeof commandFn = commandFn) {
  await fn({ values: { path: [dir] } } as any);
}

/** Generate from a full load, the way codegen worked before it switched to shape mode. */
async function fullLoadCodegen(load: typeof loadVarlockEnvGraph = loadVarlockEnvGraph) {
  const graph = await load({ entryFilePaths: [dir], mode: 'default' });
  await graph.runCodeGeneratorsIfNeeded({ ignoreAutoFalse: true });
}

// A command that creates `marker` and prints `out`. Uses node rather than touch/echo so it also runs
// on Windows, and forward slashes so the path survives both shells.
const touchCmd = (marker: string, out: string) => {
  const m = marker.replace(/\\/g, '/');
  return `node -e "require('fs').writeFileSync('${m}', ''); process.stdout.write('${out}')"`;
};

describe('varlock codegen', () => {
  test('shell commands in root decorators never run', async () => {
    const cacheMarker = path.join(dir, 'MARKER_CACHE');
    const bulkMarker = path.join(dir, 'MARKER_BULK');
    write({
      '.env.schema': outdent`
        # @cache=exec(\`${touchCmd(cacheMarker, 'memory')}\`)
        # @setValuesBulk(exec(\`${touchCmd(bulkMarker, 'A=1')}\`))
        # @generateTsTypes(path=env.d.ts)
        # ---
        A=
      `,
    });

    await codegen();
    expect(fs.existsSync(cacheMarker)).toBe(false);
    expect(fs.existsSync(bulkMarker)).toBe(false);
    expect(read('env.d.ts')).toContain('A: string');

    // control: a full load runs both
    fs.rmSync(path.join(dir, 'env.d.ts'));
    await fullLoadCodegen();
    expect(fs.existsSync(cacheMarker)).toBe(true);
    expect(fs.existsSync(bulkMarker)).toBe(true);
  });

  test('exec() in an item value never runs and the item is still typed', async () => {
    const marker = path.join(dir, 'MARKER_ITEM');
    write({
      '.env.schema': outdent`
        # @generateTsTypes(path=env.d.ts)
        # ---
        # @type=port
        TOKEN=exec(\`${touchCmd(marker, '3000')}\`)
      `,
    });
    await codegen();
    expect(fs.existsSync(marker)).toBe(false);
    expect(read('env.d.ts')).toContain('TOKEN: number');
  });

  test('a custom @icon is still downloaded, so the output does not change', async () => {
    const fetchMock = vi.fn(async () => new Response('<svg fill="currentColor"></svg>', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    // unique name so the module-level and /tmp icon caches from other tests can't hide the fetch
    const icon = `fake-test:shape-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    write({
      '.env.schema': outdent`
        # @generateTsTypes(path=env.d.ts)
        # ---
        # @icon=${icon}
        A=a
      `,
    });

    await codegen();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(read('env.d.ts')).toContain('A: string');
    expect(read('env.d.ts')).toContain('![icon]');
    // (it is cached on disk, which we clean up)
    fs.rmSync(`/tmp/varlock-icon-cache/${icon}-20.svg`, { force: true });
  });

  test('a bundled icon is still embedded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network unavailable');
    }));
    write({
      '.env.schema': outdent`
        # @generateTsTypes(path=env.d.ts)
        # ---
        # @type=url
        APP_URL=https://example.com
      `,
    });
    await codegen();
    expect(read('env.d.ts')).toContain('![icon]');
  });

  test('output does not depend on the env vars of the shell', async () => {
    write({
      '.env.schema': outdent`
        # @currentEnv=$APP_ENV
        # @generateTsTypes(path=env.d.ts, processEnv=if(forEnv(prod), none, strict))
        # ---
        # @type=enum(dev, prod)
        APP_ENV=dev
      `,
    });

    // the graph snapshots process.env when its module loads, so load the command fresh under each env
    const underEnv = async (appEnv: string, full = false) => {
      vi.stubEnv('APP_ENV', appEnv);
      vi.resetModules();
      if (full) await fullLoadCodegen((await import('../../../lib/load-graph')).loadVarlockEnvGraph);
      else await codegen((await import('../codegen.command')).commandFn);
      return read('env.d.ts');
    };

    const devOutput = await underEnv('dev');
    expect(await underEnv('prod')).toBe(devOutput);

    // control: a full load follows the shell
    expect(await underEnv('dev', true)).toBe(devOutput);
    expect(await underEnv('prod', true)).not.toBe(devOutput);
  });

  test('writes outside the schema folder like a full load (a monorepo sharing types)', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'varlock-codegen-other-'));
    try {
      const rel = path.relative(dir, path.join(other, 'env.d.ts')).replace(/\\/g, '/');
      write({
        '.env.schema': outdent`
          # @generateTsTypes(path=${rel})
          # ---
          A=a
        `,
      });
      await codegen();
      expect(fs.readFileSync(path.join(other, 'env.d.ts'), 'utf-8')).toContain('A: string');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  test('schema errors still fail the command and write nothing', async () => {
    write({
      '.env.schema': outdent`
        # @generateTsTypes(path=env.d.ts)
        # ---
        # @required=
        A=1
      `,
    });
    await expect(codegen()).rejects.toThrow('Schema error');
    expect(fs.existsSync(path.join(dir, 'env.d.ts'))).toBe(false);
  });
});

// Schemas that exercise the parts of the output that come from the graph. Generated files must be
// byte-identical between codegen and generating from a full load.
const PARITY_SCHEMAS: Record<string, Record<string, string>> = {
  'types, sensitivity and requiredness': {
    '.env.schema': outdent`
      # @defaultSensitive=false @defaultRequired=false
      # @generateTsTypes(path=env.d.ts)
      # @generatePythonEnv(path=env.py)
      # @generateGoEnv(path=env/env.go)
      # @generateRustEnv(path=src/env.rs)
      # ---
      # the public url
      # @type=url @required
      APP_URL=https://example.com
      # @type=port
      PORT=3000
      # @type=enum(dev, staging, prod)
      APP_ENV=dev
      # @type=array(number)
      SCORES=[1, 2]
      # @sensitive
      API_KEY=
      # @type=boolean
      DEBUG=false
    `,
  },
  'pure resolvers and refs': {
    '.env.schema': outdent`
      # @currentEnv=$APP_ENV
      # @generateTsTypes(path=env.d.ts)
      # ---
      # @type=enum(dev, prod)
      APP_ENV=dev
      HOST=localhost
      # @type=url
      API_URL=concat("https://", $HOST, "/api")
      # @required=forEnv(prod)
      SENTRY_DSN=
      # @type=string(startsWith=pk_) @public=eq($APP_ENV, dev)
      KEY=ref($API_URL)
    `,
  },
  imports: {
    '.env.schema': outdent`
      # @generateTsTypes(path=env.d.ts)
      # @import(./.env.shared)
      # @import(./dir/)
      # ---
      OWN=1
    `,
    '.env.shared': outdent`
      # ---
      # @type=port
      SHARED_PORT=80
    `,
    'dir/.env.schema': outdent`
      # ---
      FROM_DIR=a
    `,
    // env-specific and value-only files must not leak into the types in either mode
    '.env.production': 'OWN=2\nPROD_ONLY=1\n',
    '.env': 'VALUE_ONLY=1\n',
  },
  'exec values and root decorators that need a shell': {
    '.env.schema': outdent`
      # @cache=memory
      # @generateTsTypes(path=env.d.ts)
      # ---
      # @type=port
      PORT=exec(\`node -e "process.stdout.write('3000')"\`)
      # @type=number
      COUNT=randomInt(1, 10)
      COPY=$PORT
      # @sensitive
      SECRET=exec(\`node -e "process.stdout.write('s')"\`)
    `,
  },
  'generator options and filter': {
    '.env.schema': outdent`
      # @defaultSensitive=false
      # @generateTsTypes(path=env.d.ts, exposeEnv=none, icons=false)
      # @generateTsTypes(path=public.d.ts, filter="!@sensitive")
      # @generatePhpEnv(path=Env.php, namespace=App)
      # @generateJavaEnv(path=Env.java, package=app.env, class=Env)
      # ---
      PUBLIC_A=a
      # @sensitive
      SECRET_B=b
    `,
  },
};

describe('varlock codegen output', () => {
  test.each(Object.keys(PARITY_SCHEMAS))('matches a full load: %s', async (name) => {
    write(PARITY_SCHEMAS[name]);
    const listOutputs = () => fs.readdirSync(dir, { recursive: true, encoding: 'utf-8' })
      .filter((f) => !fs.statSync(path.join(dir, f)).isDirectory())
      .filter((f) => !Object.keys(PARITY_SCHEMAS[name]).includes(f))
      .sort();

    await fullLoadCodegen();
    const outputs = listOutputs();
    expect(outputs.length).toBeGreaterThan(0);
    const expected = Object.fromEntries(outputs.map((f) => [f, read(f)]));
    for (const f of outputs) fs.rmSync(path.join(dir, f));

    await codegen();
    expect(listOutputs()).toEqual(outputs);
    expect(Object.fromEntries(outputs.map((f) => [f, read(f)]))).toEqual(expected);
  });
});
