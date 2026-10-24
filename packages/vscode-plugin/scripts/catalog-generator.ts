/**
 * Builds the text of src/intellisense-catalog.ts from a snapshot of varlock's registries plus the
 * hand-written overlay in src/intellisense-prose.ts. Pure functions only (no file or varlock access),
 * so the logic is unit-testable with fake registries. See generate-catalog.ts for the CLI.
 *
 * - which names exist and whether a decorator is a function come from the registries (an overlay entry that
 *   disagrees about `isFunction` is reported in `isFunctionConflicts`), and so does deprecation unless only the overlay has it
 * - summary, documentation and snippets come from the overlay; if a name has no overlay entry, the summary
 *   falls back to the registry description, and then to a generic one (reported in `genericNames`)
 * - overlay entries for names the registries no longer have are dropped (reported in `orphanedOverlay`)
 */
import type { DataTypeInfo, DecoratorInfo, ResolverInfo } from '../src/intellisense-prose';

export type RegistryDecoratorDef = {
  description?: string;
  isFunction?: boolean;
  isFunctionOrValue?: boolean;
  deprecated?: boolean | string;
};

export type RegistrySnapshot = {
  rootDecorators: Record<string, RegistryDecoratorDef>;
  itemDecorators: Record<string, RegistryDecoratorDef>;
  dataTypes: Record<string, { description?: string }>;
  resolvers: Record<string, { description?: string }>;
};

export type CatalogOverlay = {
  ROOT_DECORATORS: Array<DecoratorInfo>;
  ITEM_DECORATORS: Array<DecoratorInfo>;
  DATA_TYPES: Array<DataTypeInfo>;
  RESOLVERS: Array<ResolverInfo>;
};

export type CatalogReport = {
  /** names the registries have that the overlay has no entry for, as `kind:name` */
  fromRegistryOnly: Array<string>;
  /** the subset of those with no description in the registry either, so they get a generic summary */
  genericNames: Array<string>;
  /** overlay entries for names the registries do not have, as `kind:name` */
  orphanedOverlay: Array<string>;
  /** overlay entries whose `isFunction` disagrees with the registry, as `kind:name` */
  isFunctionConflicts: Array<string>;
};

/** keep the overlay's order for known names, then append names only the registry has, in registry order */
function orderedNames<T extends { name: string }>(
  overlay: Array<T>,
  registryNames: Array<string>,
  label: string,
  report: CatalogReport,
) {
  const inRegistry = new Set(registryNames);
  const inOverlay = new Set(overlay.map((entry) => entry.name));
  for (const entry of overlay) {
    if (!inRegistry.has(entry.name)) report.orphanedOverlay.push(`${label}:${entry.name}`);
  }
  const kept = overlay.map((entry) => entry.name).filter((name) => inRegistry.has(name));
  const extra = registryNames.filter((name) => !inOverlay.has(name));
  for (const name of extra) report.fromRegistryOnly.push(`${label}:${name}`);
  return [...kept, ...extra];
}

const byName = <T extends { name: string }>(list: Array<T>) => new Map(list.map((entry) => [entry.name, entry]));

function buildDecorators(
  scope: 'root' | 'item',
  registry: Record<string, RegistryDecoratorDef>,
  overlayList: Array<DecoratorInfo>,
  report: CatalogReport,
): Array<DecoratorInfo> {
  const overlay = byName(overlayList);
  return orderedNames(overlayList, Object.keys(registry), `${scope}Decorator`, report).map((name) => {
    const def = registry[name];
    const entry = overlay.get(name);
    if (!entry && !def.description) report.genericNames.push(`${scope}Decorator:${name}`);
    const isFunction = def.isFunction;
    if (entry && !!entry.isFunction !== !!isFunction) report.isFunctionConflicts.push(`${scope}Decorator:${name}`);
    // deprecated if either side says so (code generator aliases such as @generateTypes are only marked
    // in the overlay); the overlay's wording wins when it has any
    const registryDeprecated = def.deprecated && (typeof def.deprecated === 'string' ? def.deprecated : 'Deprecated.');
    const deprecated = entry?.deprecated ?? registryDeprecated;
    return {
      name,
      scope,
      summary: entry?.summary ?? def.description ?? `@${name} ${scope} decorator.`,
      documentation: entry?.documentation ?? '',
      insertText: entry?.insertText ?? (isFunction ? `@${name}($1)` : `@${name}`),
      ...isFunction && { isFunction: true },
      ...def.isFunctionOrValue && { isFunctionOrValue: true },
      ...deprecated && { deprecated },
    };
  });
}

function buildDataTypes(registry: RegistrySnapshot['dataTypes'], overlayList: Array<DataTypeInfo>, report: CatalogReport): Array<DataTypeInfo> {
  const overlay = byName(overlayList);
  return orderedNames(overlayList, Object.keys(registry), 'dataType', report).map((name) => {
    const entry = overlay.get(name);
    const description = registry[name].description;
    if (!entry && !description) report.genericNames.push(`dataType:${name}`);
    return {
      name,
      summary: entry?.summary ?? description ?? `${name} data type.`,
      documentation: entry?.documentation ?? '',
      insertText: entry?.insertText ?? name,
      ...entry?.optionSnippets && { optionSnippets: entry.optionSnippets },
    };
  });
}

function buildResolvers(registry: RegistrySnapshot['resolvers'], overlayList: Array<ResolverInfo>, report: CatalogReport): Array<ResolverInfo> {
  const overlay = byName(overlayList);
  return orderedNames(overlayList, Object.keys(registry), 'resolver', report).map((name) => {
    const entry = overlay.get(name);
    const description = registry[name].description;
    if (!entry && !description) report.genericNames.push(`resolver:${name}`);
    return {
      name,
      summary: entry?.summary ?? description ?? `${name}() resolver.`,
      documentation: entry?.documentation ?? '',
      insertText: entry?.insertText ?? `${name}($1)`,
    };
  });
}

export function buildCatalog(registries: RegistrySnapshot, overlay: CatalogOverlay) {
  const report: CatalogReport = {
    fromRegistryOnly: [], genericNames: [], orphanedOverlay: [], isFunctionConflicts: [],
  };
  const catalog: CatalogOverlay = {
    ROOT_DECORATORS: buildDecorators('root', registries.rootDecorators, overlay.ROOT_DECORATORS, report),
    ITEM_DECORATORS: buildDecorators('item', registries.itemDecorators, overlay.ITEM_DECORATORS, report),
    DATA_TYPES: buildDataTypes(registries.dataTypes, overlay.DATA_TYPES, report),
    RESOLVERS: buildResolvers(registries.resolvers, overlay.RESOLVERS, report),
  };
  const literal = (value: unknown) => JSON.stringify(value, null, 2);
  const source = `/* eslint-disable */
// GENERATED by scripts/generate-catalog.ts from varlock's registries. Do not edit by hand.
// To change prose or snippets, edit src/intellisense-prose.ts (or the description on the registry
// definition in packages/varlock), then run \`bun run generate:catalog\` in packages/vscode-plugin.
import type { DecoratorInfo, DataTypeInfo, ResolverInfo } from './intellisense-prose';

export type { DecoratorInfo, DataTypeInfo, ResolverInfo };

export const ROOT_DECORATORS: Array<DecoratorInfo> = ${literal(catalog.ROOT_DECORATORS)};

export const ITEM_DECORATORS: Array<DecoratorInfo> = ${literal(catalog.ITEM_DECORATORS)};

export const DATA_TYPES: Array<DataTypeInfo> = ${literal(catalog.DATA_TYPES)};

export const RESOLVERS: Array<ResolverInfo> = ${literal(catalog.RESOLVERS)};

export const DECORATORS_BY_NAME = Object.fromEntries(
  [...ROOT_DECORATORS, ...ITEM_DECORATORS].map((decorator) => [decorator.name, decorator]),
) as Record<string, DecoratorInfo>;
`;
  return { source, report, catalog };
}

export const REGENERATE_HINT = 'run `bun run generate:catalog` in packages/vscode-plugin and commit the result';

/** compares the committed catalog text with what the registries and overlay would generate now */
export function checkCatalog(registries: RegistrySnapshot, overlay: CatalogOverlay, committed: string | undefined) {
  const { source, report } = buildCatalog(registries, overlay);
  const problems: Array<string> = [];
  if (committed !== source) {
    problems.push(`src/intellisense-catalog.ts is out of date with varlock's registries: ${REGENERATE_HINT}`);
  }
  if (report.orphanedOverlay.length) {
    problems.push(
      `src/intellisense-prose.ts has entries for names varlock does not register, remove them: ${report.orphanedOverlay.join(', ')}`,
    );
  }
  if (report.isFunctionConflicts.length) {
    problems.push(
      `src/intellisense-prose.ts disagrees with varlock about which decorators are functions (the registry wins), fix isFunction on: ${report.isFunctionConflicts.join(', ')}`,
    );
  }
  return { ok: problems.length === 0, problems, report };
}
