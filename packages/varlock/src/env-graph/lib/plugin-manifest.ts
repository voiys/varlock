import _ from '@env-spec/utils/my-dash';
import { SchemaError } from './errors';
import type { VarlockPlugin } from './plugins';
import {
  checkValidationRules, findValidationRulesProblem, validationRuleCheckName, type ValidationRule,
} from './validation-rules';
import type { ProxyTransformOptionSpec } from '../../proxy/types';

/**
 * A plugin manifest is a JSON description of what a plugin registers (decorators, data types,
 * resolvers, code generators, icons, standard vars), so a graph in shape mode can use the
 * plugin without running its code. It is generated from the plugin itself (see
 * `generatePluginManifest`) and shipped in the plugin package as its `./manifest` export.
 *
 * It only holds data. Everything a plugin does in code (`process()`, `execute()`, `resolve()`,
 * `coerce()`, `validate()`, `generate()`, a proxy transform's `apply()`) is left out, so a manifest
 * never makes anything run. A data type's `validate()` is described by its `validationRules`, which
 * generating the manifest checks against the real `validate()`.
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
  proxyTransformSchemes?: Array<Entry>;
};

/** true if the value is fine, false or a description of the problem if not */
type FieldCheck = (val: unknown) => boolean | string;

const isStringArray: FieldCheck = (val) => Array.isArray(val) && val.every(_.isString);
/** plain JSON data: survives JSON.stringify/parse unchanged */
const isJson: FieldCheck = (val) => {
  if (val === null || _.isString(val) || _.isBoolean(val)) return true;
  if (typeof val === 'number') return Number.isFinite(val);
  if (Array.isArray(val)) return val.every(isJson);
  if (_.isPlainObject(val)) return Object.values(val).every(isJson);
  return false;
};

// the data fields of each kind of registration, in the order they are written to a manifest.
// Function members are never carried, and unknown fields are ignored when reading.
const DECORATOR_FIELDS: Record<string, FieldCheck> = {
  name: _.isString,
  description: _.isString,
  isFunction: _.isBoolean,
  isFunctionOrValue: _.isBoolean,
  allowDualPlacement: _.isBoolean,
  inert: _.isBoolean,
  deprecated: (val) => _.isBoolean(val) || _.isString(val),
  incompatibleWith: isStringArray,
  objectValueExample: _.isString,
  useFnArgsResolver: _.isBoolean,
  skipValueResolver: _.isBoolean,
};
const COERCED_TYPE_NAMES = ['string', 'int', 'number', 'boolean', 'object'];
/** the shapes of `CoercedType` in data-types.ts */
const isCoercedType = (val: unknown): boolean => {
  if (_.isString(val)) return COERCED_TYPE_NAMES.includes(val as string);
  if (!_.isPlainObject(val)) return false;
  const keys = Object.keys(val);
  if (keys.length !== 1) return false;
  if (keys[0] === 'enum') {
    return Array.isArray(val.enum) && val.enum.every((v) => _.isString(v) || _.isBoolean(v) || Number.isFinite(v));
  }
  if (keys[0] === 'arrayOf') return isCoercedType(val.arrayOf);
  if (keys[0] === 'recordOf') {
    const { recordOf } = val;
    return _.isPlainObject(recordOf)
      && Object.keys(recordOf).every((k) => k === 'keys' || k === 'values')
      && Object.values(recordOf).every(isCoercedType);
  }
  return false;
};

const DATA_TYPE_FIELDS: Record<string, FieldCheck> = {
  name: _.isString,
  typeDescription: _.isString,
  icon: _.isString,
  coercedType: isCoercedType,
  sensitive: _.isBoolean,
  internal: _.isBoolean,
  docs: (val) => Array.isArray(val)
    && val.every((d) => _.isString(d) || (_.isPlainObject(d) && _.isString(d.url) && _.isString(d.description))),
  validationRules: (val) => findValidationRulesProblem(val) ?? true,
  // true when the plugin coerces values in code, which a manifest cannot carry
  coerceUnavailable: _.isBoolean,
};
const RESOLVER_FIELDS: Record<string, FieldCheck> = {
  name: _.isString,
  label: _.isString,
  description: _.isString,
  icon: _.isString,
  inferredType: _.isString,
  inferredTypeSettings: (val) => _.isPlainObject(val) && isJson(val),
  impliesSensitive: _.isBoolean,
  argsSchema: (val) => _.isPlainObject(val) && ['array', 'object', 'mixed'].includes(val.type as string)
    && Object.entries(val).every(([k, v]) => k === 'type' || (Number.isInteger(v) && (v as number) >= 0)),
};
const CODE_GENERATOR_FIELDS: Record<string, FieldCheck> = {
  decoratorName: _.isString,
  knownOptions: isStringArray,
};
const PROXY_OPTION_TYPES = ['string', 'headerName', 'template', 'stringList', 'enum'];
/** the shape of `ProxyTransformOptionSpec` in proxy/types.ts */
const isProxyOptionSpec = (val: unknown) => _.isPlainObject(val)
  && PROXY_OPTION_TYPES.includes(val.type as string)
  && (val.required === undefined || _.isBoolean(val.required))
  && (val.enumValues === undefined || isStringArray(val.enumValues))
  && (val.itemRole === undefined || val.itemRole === 'consumed' || val.itemRole === 'wire')
  && Object.keys(val).every((key) => ['type', 'required', 'enumValues', 'itemRole'].includes(key));
const PROXY_TRANSFORM_SCHEME_FIELDS: Record<string, FieldCheck> = {
  scheme: _.isString,
  options: (val) => _.isPlainObject(val) && Object.values(val).every(isProxyOptionSpec),
};

/** copies the known data fields of `def`, in a stable order, checking each one */
function pickFields(def: Entry, fields: Record<string, FieldCheck>, nameKey: string, where: string): Entry {
  if (!_.isPlainObject(def) || !_.isString(def[nameKey]) || !def[nameKey]) {
    throw new Error(`${where}: expected an object with a "${nameKey}"`);
  }
  const picked: Entry = {};
  for (const [field, check] of Object.entries(fields)) {
    if (def[field] === undefined) continue;
    const result = check(def[field]);
    if (result !== true) {
      const detail = typeof result === 'string' ? ` (${result})` : '';
      throw new Error(`${where} "${def[nameKey]}": unsupported value for "${field}"${detail}`);
    }
    picked[field] = def[field];
  }
  return picked;
}

const isStandardVars = (val: unknown) => _.isPlainObject(val)
  && _.isString(val.initDecorator)
  && _.isPlainObject(val.params)
  && Object.values(val.params).every((p) => _.isPlainObject(p)
    && (_.isString(p.key) || (isStringArray(p.key) && (p.key as Array<string>).length > 0))
    && (p.dataType === undefined || _.isString(p.dataType)));

/** the defs of a plugin's data types. A data type that takes settings is a function of them: describe it with no settings */
export function pluginDataTypeDefs(plugin: VarlockPlugin) {
  return (plugin.dataTypes ?? []).map((d) => (typeof d === 'function' ? d() : d));
}

/** builds the manifest for a plugin whose module has already been executed */
export function createPluginManifest(plugin: VarlockPlugin, dataTypeDefs = pluginDataTypeDefs(plugin)): PluginManifest {
  for (const schemeDef of plugin.proxyTransformSchemes ?? []) {
    // the option specs are data, but these hooks are code that changes what a config means or allows
    if (schemeDef.validate || schemeDef.placeAttachedItem) {
      throw new Error(`Plugin ${plugin.name} registers proxy transform scheme "${schemeDef.scheme}" with validate() or placeAttachedItem(), which a manifest cannot describe`);
    }
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
  for (const def of dataTypeDefs) {
    if (typeof def.validate === 'function' && !def.validationRules) {
      throw new Error(`Data type "${def.name}" has validate() but no validationRules. Describe its checks as rules (a { custom } rule stands for a check that only runs in code)`);
    }
    if (typeof def.coerce === 'function' && def.validationRules?.some((rule) => !('custom' in rule))) {
      throw new Error(`Data type "${def.name}" coerces values in code, so its validationRules (which check the string value) can't be used`);
    }
  }
  manifest.dataTypes = pick(dataTypeDefs, DATA_TYPE_FIELDS, 'data type').map((entry, i) => (
    typeof dataTypeDefs[i].coerce === 'function' ? { ...entry, coerceUnavailable: true } : entry
  ));
  manifest.resolvers = pick(plugin.resolverFunctions, RESOLVER_FIELDS, 'resolver');
  manifest.codeGenerators = pick(plugin.codeGenerators, CODE_GENERATOR_FIELDS, 'code generator', 'decoratorName');
  if (plugin.proxyTransformSchemes?.length) {
    manifest.proxyTransformSchemes = pick(plugin.proxyTransformSchemes, PROXY_TRANSFORM_SCHEME_FIELDS, 'proxy transform scheme', 'scheme');
  }
  return manifest;
}

/** what a data type's real validate() says about a value: undefined if it passes */
async function runValidate(validate: (val: any) => unknown, val: string) {
  let result: unknown;
  try {
    result = await validate(val);
  } catch (err) {
    result = err;
  }
  const error = Array.isArray(result) ? result[0] : result;
  if (error instanceof Error) return { message: error.message, tip: (error as any).tip as string | undefined };
  if (result === false) return { message: '(returned false)', tip: undefined };
  return undefined;
}

/** values that probe each rule, added to the samples a plugin gives */
function derivedSamples(rules: Array<ValidationRule>, givenSamples: Array<string>): Array<string> {
  const samples = ['', ' ', 'a', '0', 'x'.repeat(64), ' \t\n'];
  for (const rule of rules) {
    for (const key of ['startsWith', 'endsWith', 'includes'] as const) {
      if (!(key in rule)) continue;
      const text = (rule as Record<string, any>)[key] as string;
      samples.push(text, text.slice(0, -1), `x${text}`, `${text}x`, `x${text}x`);
    }
  }
  // each value cut or padded to just under, at and just over every length a rule names,
  // so a boundary is probed with values that pass the other rules too
  const base = [...givenSamples, ...samples];
  for (const rule of rules) {
    for (const key of ['minLength', 'maxLength', 'isLength'] as const) {
      if (!(key in rule)) continue;
      const length = (rule as Record<string, any>)[key] as number;
      for (const target of [length - 1, length, length + 1]) {
        if (target < 0) continue;
        for (const sample of base) {
          samples.push(sample.length >= target ? sample.slice(0, target) : sample.padEnd(target, 'a'));
        }
      }
    }
  }
  return samples;
}

/**
 * Checks that a data type's `validationRules` give the same result as its `validate()` on its
 * `validationSamples` (plus values derived from the rules), and that the samples make every rule
 * fail at least once. Returns the problems found. This runs plugin code: only use it at build time.
 */
export async function checkDataTypeValidationRules(def: {
  name: string,
  validate?: (val: any) => unknown,
  validationRules?: Array<ValidationRule>,
  validationSamples?: Array<string>,
}): Promise<Array<string>> {
  const rules = def.validationRules;
  if (!rules || !def.validate) return [];
  const problems: Array<string> = [];
  const where = `data type "${def.name}"`;
  const givenSamples = def.validationSamples ?? [];
  const samples = [...new Set([...givenSamples, ...derivedSamples(rules, givenSamples)])];
  const failedRules = new Set<number>();
  let someSamplePasses = false;
  for (const sample of samples) {
    const fromRules = checkValidationRules(sample, rules);
    const fromCode = await runValidate(def.validate, sample);
    const shown = JSON.stringify(sample);
    if (fromRules.passed === false) {
      failedRules.add(fromRules.index);
      const { message, tip } = fromRules.rule;
      if (!fromCode) {
        problems.push(`${where}: rule ${fromRules.index + 1} rejects ${shown}, but validate() accepts it`);
      } else if (fromCode.message !== message || fromCode.tip !== tip) {
        problems.push(`${where}: for ${shown} rule ${fromRules.index + 1} gives ${JSON.stringify(message)}, but validate() gives ${JSON.stringify(fromCode.message)}${fromCode.tip !== tip ? ' (or a different tip)' : ''}`);
      }
    } else {
      someSamplePasses = true;
      // past a custom rule, only the plugin's code knows the answer
      if (fromRules.passed === true && fromCode) {
        problems.push(`${where}: the rules accept ${shown}, but validate() rejects it with ${JSON.stringify(fromCode.message)}`);
      }
    }
  }
  rules.forEach((rule, i) => {
    if (!('custom' in rule) && !failedRules.has(i)) {
      problems.push(`${where}: no sample fails rule ${i + 1} (${validationRuleCheckName(rule)}), add one to validationSamples`);
    }
  });
  if (!someSamplePasses) problems.push(`${where}: no sample passes the rules, add one to validationSamples`);
  return problems;
}

/**
 * Validates manifest JSON read from a plugin package and returns a manifest holding only known data
 * fields. Throws a SchemaError describing the first problem.
 */
export function parsePluginManifest(raw: unknown, expectedName: string, manifestPath: string): PluginManifest {
  const fail = (problem: string): never => {
    throw new SchemaError(`Plugin manifest ${manifestPath} is invalid: ${problem}`);
  };
  if (!_.isPlainObject(raw)) return fail('expected a JSON object');
  if (raw.manifestVersion !== PLUGIN_MANIFEST_VERSION) {
    const version = JSON.stringify(raw.manifestVersion);
    return fail(`unsupported manifestVersion ${version} (this version of varlock reads ${PLUGIN_MANIFEST_VERSION})`);
  }
  if (raw.name !== expectedName) return fail(`it describes "${String(raw.name)}", not "${expectedName}"`);
  if (raw.icon !== undefined && !_.isString(raw.icon)) fail('"icon" must be a string');
  const { bundledIcons } = raw;
  if (bundledIcons !== undefined && !(_.isPlainObject(bundledIcons) && Object.values(bundledIcons).every(_.isString))) {
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
    ['proxyTransformSchemes', PROXY_TRANSFORM_SCHEME_FIELDS, 'scheme'],
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
  for (const def of manifest.dataTypes ?? []) plugin.registerDataType(def as any);
  for (const def of manifest.resolvers ?? []) {
    plugin.registerResolverFunction({ ...def, resolve: cannotRun(`${def.name}()`) } as any);
  }
  for (const def of manifest.codeGenerators ?? []) {
    plugin.registerCodeGenerator({ ...def, generate: cannotRun(`@${def.decoratorName}`) } as any);
  }
  // the option specs are enough to check a transform config; apply() only runs in the proxy
  for (const def of manifest.proxyTransformSchemes ?? []) {
    plugin.registerProxyTransformScheme({
      scheme: def.scheme as string,
      options: def.options as Record<string, ProxyTransformOptionSpec>,
      apply: cannotRun(`proxy transform scheme "${def.scheme}"`),
    });
  }
  plugin.loadedFromManifest = true;
}
