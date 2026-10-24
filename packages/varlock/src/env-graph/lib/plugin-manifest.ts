import { SchemaError } from './errors';
import type { VarlockPlugin } from './plugins';

/**
 * A plugin manifest is a JSON description of what a plugin registers (decorators, data types,
 * resolvers, code generators, icons, standard vars), so a graph in shape mode can use the
 * plugin without running its code. It is generated from the plugin itself (see
 * `generatePluginManifest`) and shipped in the plugin package as its `./manifest` export.
 *
 * It only holds data. Everything a plugin does in code (`process()`, `execute()`, `resolve()`,
 * `coerce()`, `validate()`, `generate()`) is left out, so a manifest never makes anything run.
 */
export const PLUGIN_MANIFEST_VERSION = 1;

type Entry = Record<string, unknown>;
export type PluginManifest = {
  manifestVersion: typeof PLUGIN_MANIFEST_VERSION;
  /** the plugin package name, checked against the package.json it is shipped in */
  name: string;
  icon?: string;
  bundledIcons?: Record<string, string>;
  standardVars?: VarlockPlugin['standardVars'];
  rootDecorators?: Array<Entry>;
  itemDecorators?: Array<Entry>;
  dataTypes?: Array<Entry>;
  resolvers?: Array<Entry>;
  codeGenerators?: Array<Entry>;
};

type FieldCheck = (val: unknown) => boolean;

const isString: FieldCheck = (val) => typeof val === 'string';
const isBoolean: FieldCheck = (val) => typeof val === 'boolean';
const isStringArray: FieldCheck = (val) => Array.isArray(val) && val.every(isString);
const isPlainObject = (val: unknown): val is Record<string, unknown> => (
  typeof val === 'object' && val !== null && Object.getPrototypeOf(val) === Object.prototype
);
/** plain JSON data: survives JSON.stringify/parse unchanged */
const isJson: FieldCheck = (val) => {
  if (val === null || isString(val) || isBoolean(val)) return true;
  if (typeof val === 'number') return Number.isFinite(val);
  if (Array.isArray(val)) return val.every(isJson);
  if (isPlainObject(val)) return Object.values(val).every(isJson);
  return false;
};

// the data fields of each kind of registration, in the order they are written to a manifest.
// Function members are never carried, and unknown fields are ignored when reading.
const DECORATOR_FIELDS: Record<string, FieldCheck> = {
  name: isString,
  description: isString,
  isFunction: isBoolean,
  isFunctionOrValue: isBoolean,
  allowDualPlacement: isBoolean,
  inert: isBoolean,
  deprecated: (val) => isBoolean(val) || isString(val),
  incompatibleWith: isStringArray,
  objectValueExample: isString,
  useFnArgsResolver: isBoolean,
  skipValueResolver: isBoolean,
};
const COERCED_TYPE_NAMES = ['string', 'int', 'number', 'boolean', 'object'];
/** the shapes of `CoercedType` in data-types.ts */
const isCoercedType = (val: unknown): boolean => {
  if (isString(val)) return COERCED_TYPE_NAMES.includes(val as string);
  if (!isPlainObject(val)) return false;
  const keys = Object.keys(val);
  if (keys.length !== 1) return false;
  if (keys[0] === 'enum') {
    return Array.isArray(val.enum) && val.enum.every((v) => isString(v) || isBoolean(v) || Number.isFinite(v));
  }
  if (keys[0] === 'arrayOf') return isCoercedType(val.arrayOf);
  if (keys[0] === 'recordOf') {
    const { recordOf } = val;
    return isPlainObject(recordOf)
      && Object.keys(recordOf).every((k) => k === 'keys' || k === 'values')
      && Object.values(recordOf).every(isCoercedType);
  }
  return false;
};

const DATA_TYPE_FIELDS: Record<string, FieldCheck> = {
  name: isString,
  typeDescription: isString,
  icon: isString,
  coercedType: isCoercedType,
  sensitive: isBoolean,
  internal: isBoolean,
  docs: (val) => Array.isArray(val)
    && val.every((d) => isString(d) || (isPlainObject(d) && isString(d.url) && isString(d.description))),
  // not a def field: true when the plugin coerces values in code, which a manifest cannot carry
  customCoerce: isBoolean,
};
const RESOLVER_FIELDS: Record<string, FieldCheck> = {
  name: isString,
  label: isString,
  description: isString,
  icon: isString,
  inferredType: isString,
  inferredTypeSettings: (val) => isPlainObject(val) && isJson(val),
  impliesSensitive: isBoolean,
  argsSchema: (val) => isPlainObject(val) && ['array', 'object', 'mixed'].includes(val.type as string)
    && Object.entries(val).every(([k, v]) => k === 'type' || (Number.isInteger(v) && (v as number) >= 0)),
};
const CODE_GENERATOR_FIELDS: Record<string, FieldCheck> = {
  decoratorName: isString,
  knownOptions: isStringArray,
};

/** copies the known data fields of `def`, in a stable order, checking each one */
function pickFields(def: Entry, fields: Record<string, FieldCheck>, nameKey: string, where: string): Entry {
  if (!isPlainObject(def) || !isString(def[nameKey]) || !def[nameKey]) {
    throw new Error(`${where}: expected an object with a "${nameKey}"`);
  }
  const picked: Entry = {};
  for (const [field, check] of Object.entries(fields)) {
    if (def[field] === undefined) continue;
    if (!check(def[field])) throw new Error(`${where} "${def[nameKey]}": unsupported value for "${field}"`);
    picked[field] = def[field];
  }
  return picked;
}

const isStandardVars = (val: unknown) => isPlainObject(val)
  && isString(val.initDecorator)
  && isPlainObject(val.params)
  && Object.values(val.params).every((p) => isPlainObject(p)
    && (isString(p.key) || (isStringArray(p.key) && (p.key as Array<string>).length > 0))
    && (p.dataType === undefined || isString(p.dataType)));

/** builds the manifest for a plugin whose module has already been executed */
export function createPluginManifest(plugin: VarlockPlugin): PluginManifest {
  if (plugin.proxyTransformSchemes?.length) {
    throw new Error(`Plugin ${plugin.name} registers proxy transform schemes, which a manifest cannot describe yet`);
  }
  const manifest: PluginManifest = { manifestVersion: PLUGIN_MANIFEST_VERSION, name: plugin.name };
  if (plugin.icon) manifest.icon = plugin.icon;
  if (plugin.bundledIcons && Object.keys(plugin.bundledIcons).length) {
    manifest.bundledIcons = { ...plugin.bundledIcons };
  }
  if (plugin.standardVars) {
    if (!isStandardVars(plugin.standardVars)) throw new Error(`Plugin ${plugin.name} has standardVars with an unexpected shape`);
    manifest.standardVars = structuredClone(plugin.standardVars);
  }
  const pick = (defs: Array<any> | undefined, fields: Record<string, FieldCheck>, where: string, nameKey = 'name') => (
    (defs ?? []).map((def) => pickFields(def, fields, nameKey, where))
  );
  manifest.rootDecorators = pick(plugin.rootDecorators, DECORATOR_FIELDS, 'root decorator');
  manifest.itemDecorators = pick(plugin.itemDecorators, DECORATOR_FIELDS, 'item decorator');
  // a data type that takes settings is a function of them: describe it with no settings
  const dataTypeDefs = plugin.dataTypes?.map((d) => (typeof d === 'function' ? d() : d));
  manifest.dataTypes = pick(dataTypeDefs, DATA_TYPE_FIELDS, 'data type').map((entry, i) => (
    typeof dataTypeDefs![i].coerce === 'function' ? { ...entry, customCoerce: true } : entry
  ));
  manifest.resolvers = pick(plugin.resolverFunctions, RESOLVER_FIELDS, 'resolver');
  manifest.codeGenerators = pick(plugin.codeGenerators, CODE_GENERATOR_FIELDS, 'code generator', 'decoratorName');
  return manifest;
}

/**
 * Validates manifest JSON read from a plugin package and returns a manifest holding only known data
 * fields. Throws a SchemaError describing the first problem.
 */
export function parsePluginManifest(raw: unknown, expectedName: string, manifestPath: string): PluginManifest {
  const fail = (problem: string): never => {
    throw new SchemaError(`Plugin manifest ${manifestPath} is invalid: ${problem}`);
  };
  if (!isPlainObject(raw)) return fail('expected a JSON object');
  if (raw.manifestVersion !== PLUGIN_MANIFEST_VERSION) {
    const version = JSON.stringify(raw.manifestVersion);
    return fail(`unsupported manifestVersion ${version} (this version of varlock reads ${PLUGIN_MANIFEST_VERSION})`);
  }
  if (raw.name !== expectedName) return fail(`it describes "${String(raw.name)}", not "${expectedName}"`);
  if (raw.icon !== undefined && !isString(raw.icon)) fail('"icon" must be a string');
  const { bundledIcons } = raw;
  if (bundledIcons !== undefined && !(isPlainObject(bundledIcons) && Object.values(bundledIcons).every(isString))) {
    fail('"bundledIcons" must map icon names to SVG strings');
  }
  if (raw.standardVars !== undefined && !isStandardVars(raw.standardVars)) fail('"standardVars" has an unexpected shape');

  const manifest: PluginManifest = { manifestVersion: PLUGIN_MANIFEST_VERSION, name: expectedName };
  if (raw.icon !== undefined) manifest.icon = raw.icon as string;
  if (raw.bundledIcons !== undefined) manifest.bundledIcons = raw.bundledIcons as Record<string, string>;
  if (raw.standardVars !== undefined) manifest.standardVars = raw.standardVars as PluginManifest['standardVars'];
  const sections = [
    ['rootDecorators', DECORATOR_FIELDS, 'name'],
    ['itemDecorators', DECORATOR_FIELDS, 'name'],
    ['dataTypes', DATA_TYPE_FIELDS, 'name'],
    ['resolvers', RESOLVER_FIELDS, 'name'],
    ['codeGenerators', CODE_GENERATOR_FIELDS, 'decoratorName'],
  ] as const;
  for (const [section, fields, nameKey] of sections) {
    const entries = raw[section];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) return fail(`"${section}" must be an array`);
    try {
      manifest[section] = entries.map((entry) => pickFields(entry, fields, nameKey, section));
    } catch (err) {
      return fail((err as Error).message);
    }
  }
  return manifest;
}

/**
 * Fills a plugin's registrations from its manifest, in place of running the plugin module.
 * Resolvers and code generators get a stub that throws if called: shape mode never resolves a
 * non-pure resolver or runs a generator, and a manifest is only read in shape mode.
 */
export function applyPluginManifest(plugin: VarlockPlugin, manifest: PluginManifest) {
  const cannotRun = (what: string) => () => {
    throw new Error(`${what} is described by the ${plugin.name} manifest and cannot run`);
  };
  plugin.icon = manifest.icon;
  if (manifest.bundledIcons) plugin.bundledIcons = { ...manifest.bundledIcons };
  if (manifest.standardVars) plugin.standardVars = structuredClone(manifest.standardVars);
  for (const def of manifest.rootDecorators ?? []) plugin.registerRootDecorator(def as any);
  for (const def of manifest.itemDecorators ?? []) plugin.registerItemDecorator(def as any);
  for (const { customCoerce, ...def } of manifest.dataTypes ?? []) {
    plugin.registerDataType({ ...def, ...(customCoerce === true && { _coerceUnavailable: true }) } as any);
  }
  for (const def of manifest.resolvers ?? []) {
    plugin.registerResolverFunction({ ...def, resolve: cannotRun(`${def.name}()`) } as any);
  }
  for (const def of manifest.codeGenerators ?? []) {
    plugin.registerCodeGenerator({ ...def, generate: cannotRun(`@${def.decoratorName}`) } as any);
  }
  plugin.loadedFromManifest = true;
}
