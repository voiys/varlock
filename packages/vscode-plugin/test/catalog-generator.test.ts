/* eslint-disable no-template-curly-in-string */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildCatalog, checkCatalog, type CatalogOverlay, type RegistrySnapshot,
} from '../scripts/catalog-generator';
import { readVarlockRegistries } from '../scripts/registry-snapshot';
import * as realOverlay from '../src/intellisense-prose';
import {
  DATA_TYPES, DECORATORS_BY_NAME, ITEM_DECORATORS, RESOLVERS, ROOT_DECORATORS,
} from '../src/intellisense-catalog';

const CATALOG_PATH = path.resolve(__dirname, '../src/intellisense-catalog.ts');

const registries: RegistrySnapshot = {
  rootDecorators: {
    currentEnv: {},
    gen: { isFunction: true },
    oldThing: { deprecated: 'use @currentEnv instead' },
    noProse: {},
    describedInRegistry: { description: 'Registry words.' },
  },
  itemDecorators: { required: {}, tagLike: { isFunction: true } },
  dataTypes: { string: {}, shiny: { description: 'registry type words' } },
  resolvers: { concat: {}, shout: { description: 'registry resolver words' } },
};

const overlay: CatalogOverlay = {
  ROOT_DECORATORS: [
    {
      name: 'currentEnv', scope: 'root', summary: 'hand summary', documentation: 'hand docs', insertText: '@currentEnv=$${1:APP_ENV}',
    },
    {
      name: 'oldThing', scope: 'root', summary: 'old', documentation: '', insertText: '@oldThing', deprecated: 'Hand wording.',
    },
  ],
  ITEM_DECORATORS: [
    {
      name: 'required', scope: 'item', summary: 'req', documentation: '', insertText: '@required',
    },
  ],
  DATA_TYPES: [
    {
      name: 'string', summary: 'text', documentation: '', insertText: 'string', optionSnippets: [{ name: 'minLength', insertText: 'minLength=${1:1}', documentation: 'min' }],
    },
  ],
  RESOLVERS: [
    {
      name: 'concat', summary: 'join', documentation: '', insertText: 'concat(${1:a}, ${2:b})',
    },
  ],
};

describe('buildCatalog', () => {
  it('lists exactly the names the registries have, overlay names first in overlay order', () => {
    const { catalog } = buildCatalog(registries, overlay);
    expect(catalog.ROOT_DECORATORS.map((d) => d.name)).toEqual(['currentEnv', 'oldThing', 'gen', 'noProse', 'describedInRegistry']);
    expect(catalog.ITEM_DECORATORS.map((d) => d.name)).toEqual(['required', 'tagLike']);
    expect(catalog.DATA_TYPES.map((d) => d.name)).toEqual(['string', 'shiny']);
    expect(catalog.RESOLVERS.map((d) => d.name)).toEqual(['concat', 'shout']);
  });

  it('uses overlay prose and snippets when present', () => {
    const { catalog } = buildCatalog(registries, overlay);
    expect(catalog.ROOT_DECORATORS[0]).toEqual({
      name: 'currentEnv', scope: 'root', summary: 'hand summary', documentation: 'hand docs', insertText: '@currentEnv=$${1:APP_ENV}',
    });
    expect(catalog.DATA_TYPES[0].optionSnippets).toHaveLength(1);
    expect(catalog.RESOLVERS[0].insertText).toBe('concat(${1:a}, ${2:b})');
  });

  it('falls back to the registry description, then to a generic entry, for names without prose', () => {
    const { catalog, report } = buildCatalog(registries, overlay);
    const byName = Object.fromEntries(catalog.ROOT_DECORATORS.map((d) => [d.name, d]));
    expect(byName.describedInRegistry.summary).toBe('Registry words.');
    expect(byName.noProse.summary).toBe('@noProse root decorator.');
    expect(byName.noProse.insertText).toBe('@noProse');
    expect(byName.gen).toMatchObject({ insertText: '@gen($1)', isFunction: true });
    expect(catalog.DATA_TYPES[1].summary).toBe('registry type words');
    expect(catalog.RESOLVERS[1]).toMatchObject({ summary: 'registry resolver words', insertText: 'shout($1)' });
    expect(report.genericNames).toEqual(['rootDecorator:gen', 'rootDecorator:noProse', 'itemDecorator:tagLike']);
    expect(report.fromRegistryOnly).toContain('resolver:shout');
  });

  it('takes function and deprecated state from the registry and keeps the overlay wording', () => {
    const { catalog } = buildCatalog(registries, overlay);
    expect(catalog.ROOT_DECORATORS[1].deprecated).toBe('Hand wording.');
    expect(catalog.ROOT_DECORATORS.find((d) => d.name === 'gen')?.isFunction).toBe(true);
    expect(catalog.ROOT_DECORATORS.find((d) => d.name === 'currentEnv')?.isFunction).toBeUndefined();

    const plain = buildCatalog(
      { ...registries, rootDecorators: { oldThing: { deprecated: 'use @x instead' }, flagged: { deprecated: true } } },
      { ...overlay, ROOT_DECORATORS: [] },
    ).catalog;
    expect(plain.ROOT_DECORATORS.map((d) => d.deprecated)).toEqual(['use @x instead', 'Deprecated.']);
  });

  it('lets the registry decide isFunction and reports an overlay that disagrees', () => {
    const disagreeing: CatalogOverlay = {
      ...overlay,
      ROOT_DECORATORS: [
        { ...overlay.ROOT_DECORATORS[0], isFunction: true },
        { ...overlay.ROOT_DECORATORS[1] },
        {
          name: 'gen', scope: 'root', summary: 'g', documentation: '', insertText: '@gen',
        },
      ],
    };
    const { catalog, report } = buildCatalog(registries, disagreeing);
    const flag = (name: string) => catalog.ROOT_DECORATORS.find((d) => d.name === name)?.isFunction;
    expect(flag('currentEnv')).toBeUndefined();
    expect(flag('gen')).toBe(true);
    expect(report.isFunctionConflicts).toEqual(['rootDecorator:currentEnv', 'rootDecorator:gen']);
    const check = checkCatalog(registries, disagreeing, buildCatalog(registries, disagreeing).source);
    expect(check.ok).toBe(false);
    expect(check.problems.join('\n')).toContain('rootDecorator:currentEnv');
  });

  it('drops overlay entries for names the registries no longer have, and reports them', () => {
    const stale: CatalogOverlay = {
      ...overlay,
      ROOT_DECORATORS: [
        ...overlay.ROOT_DECORATORS, {
          name: 'removedUpstream', scope: 'root', summary: 'x', documentation: '', insertText: '@removedUpstream',
        },
      ],
    };
    const { source, report } = buildCatalog(registries, stale);
    expect(source).not.toContain('removedUpstream');
    expect(report.orphanedOverlay).toEqual(['rootDecorator:removedUpstream']);
  });

  it('is deterministic', () => {
    expect(buildCatalog(registries, overlay).source).toBe(buildCatalog(registries, overlay).source);
  });
});

describe('checkCatalog (drift detection)', () => {
  const fresh = buildCatalog(registries, overlay).source;

  it('passes when the committed text matches', () => {
    expect(checkCatalog(registries, overlay, fresh)).toMatchObject({ ok: true, problems: [] });
  });

  it('fails when varlock gains a decorator the committed catalog does not have', () => {
    const grown: RegistrySnapshot = { ...registries, itemDecorators: { ...registries.itemDecorators, brandNew: {} } };
    const result = checkCatalog(grown, overlay, fresh);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('out of date');
    expect(result.problems[0]).toContain('bun run generate:catalog');
  });

  it('fails when varlock drops a resolver the committed catalog still lists', () => {
    const shrunk: RegistrySnapshot = { ...registries, resolvers: { concat: {} } };
    expect(checkCatalog(shrunk, overlay, fresh).ok).toBe(false);
  });

  it('fails when a registry description changes under a name with no overlay prose', () => {
    const edited: RegistrySnapshot = { ...registries, resolvers: { ...registries.resolvers, shout: { description: 'new words' } } };
    expect(checkCatalog(edited, overlay, fresh).ok).toBe(false);
  });

  it('fails when the catalog file is missing', () => {
    expect(checkCatalog(registries, overlay, undefined).ok).toBe(false);
  });

  it('fails on dead overlay entries even if the generated text is current', () => {
    const stale: CatalogOverlay = {
      ...overlay,
      RESOLVERS: [
        ...overlay.RESOLVERS, {
          name: 'gone', summary: 'x', documentation: '', insertText: 'gone()',
        },
      ],
    };
    const result = checkCatalog(registries, stale, buildCatalog(registries, stale).source);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('resolver:gone');
  });
});

describe('committed catalog vs the real varlock registries', () => {
  const real = readVarlockRegistries();

  it('has an entry for every built-in decorator, data type and resolver', () => {
    const missing = {
      rootDecorators: Object.keys(real.rootDecorators).filter((n) => !ROOT_DECORATORS.some((d) => d.name === n)),
      itemDecorators: Object.keys(real.itemDecorators).filter((n) => !ITEM_DECORATORS.some((d) => d.name === n)),
      dataTypes: Object.keys(real.dataTypes).filter((n) => !DATA_TYPES.some((d) => d.name === n)),
      resolvers: Object.keys(real.resolvers).filter((n) => !RESOLVERS.some((d) => d.name === n)),
    };
    expect(missing).toEqual({
      rootDecorators: [], itemDecorators: [], dataTypes: [], resolvers: [],
    });
  });

  it('has no entries for names varlock does not register', () => {
    expect(ROOT_DECORATORS.map((d) => d.name).filter((n) => !(n in real.rootDecorators))).toEqual([]);
    expect(ITEM_DECORATORS.map((d) => d.name).filter((n) => !(n in real.itemDecorators))).toEqual([]);
    expect(DATA_TYPES.map((d) => d.name).filter((n) => !(n in real.dataTypes))).toEqual([]);
    expect(RESOLVERS.map((d) => d.name).filter((n) => !(n in real.resolvers))).toEqual([]);
  });

  it('is byte-for-byte what the generator produces now', () => {
    const result = checkCatalog(real, realOverlay, fs.readFileSync(CATALOG_PATH, 'utf8'));
    expect(result.problems).toEqual([]);
  });

  it('includes the resolvers the loader registers on top of a bare EnvGraph', () => {
    const names = RESOLVERS.map((r) => r.name);
    expect(names).toContain('varlock');
    expect(names).toContain('keychain');
  });

  it('keeps both the header and the item form of @proxy', () => {
    expect(ROOT_DECORATORS.find((d) => d.name === 'proxy')?.summary).toContain('detached');
    expect(ITEM_DECORATORS.find((d) => d.name === 'proxy')?.summary).toContain('credential proxy');
    expect(DECORATORS_BY_NAME.proxy.isFunction).toBe(true);
    expect(ITEM_DECORATORS.find((d) => d.name === 'proxy')?.isFunctionOrValue).toBe(true);
    expect(ROOT_DECORATORS.find((d) => d.name === 'proxy')?.isFunctionOrValue).toBeUndefined();
  });
});
