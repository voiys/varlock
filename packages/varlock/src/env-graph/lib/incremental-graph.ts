/**
 * Experiment (lsp-incremental-experiment): update a loaded and resolved EnvGraph in place after an edit to the
 * root schema file, re-processing and re-resolving only the items the edit affects.
 *
 * The contract is that the graph ends up exactly as a full rebuild of the new text would leave it, for every
 * diagnostic an editor shows. Two kinds of edit are handled:
 *  - edits below the header (items added, removed or changed)
 *  - header edits that only change the pick/omit list of one `@import` (keys enter or leave the graph)
 * Anything this cannot do exactly is refused before the graph is touched, and the caller rebuilds: other header
 * edits, the current-env item, keys a built-in root decorator depends on, builtin and reserved keys, duplicate
 * keys, keys defined in more than one file, graphs with dependency cycles or `@dynamic=boot` items, graph-level
 * root decorators whose result depends on whether the schema has errors, and graphs not in shape mode.
 */
import { ParsedEnvSpecConfigItem, type ParsedEnvSpecDecorator, type ParsedEnvSpecFile } from '@env-spec/parser';
import { ConfigItem, type ConfigItemDef } from './config-item';
import { DotEnvFileDataSource, type EnvGraphDataSource } from './data-source';
import type { EnvGraph } from './env-graph';
import { findGraphCycles } from './graph-utils';
import { isBuiltinVar } from './builtin-vars';
import { isVarlockReservedKey } from './reserved-vars';
import { builtInRootDecorators, RootDecoratorInstance } from './decorators';
import { parseKeyFilterArgs } from './key-filter';

export type SourceEdit = {
  /** the new tree of the whole file (from reparseEnvSpecIncremental) */
  file: ParsedEnvSpecFile;
  /** the new text */
  rawContents: string;
  /** top-level nodes `oldFile.contents[oldStart, oldEnd)` were replaced by `file.contents[newStart, newEnd)` */
  oldFile: ParsedEnvSpecFile;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  /** lines the edit added (negative: removed) */
  lineDelta: number;
};

export type IncrementalResult = | {
  applied: true,
  /** items that were re-created, re-processed and re-resolved */
  rebuiltKeys: Array<string>,
  addedKeys: Array<string>,
  removedKeys: Array<string>,
  /** every item whose errors may differ from before (rebuilt ones plus cross-item warnings that moved) */
  touchedKeys: Array<string>,
}
  | { applied: false, reason: string, mutated: boolean };

// graph-level root decorators that finishLoad only resolves when the schema has no errors
const ERROR_STATE_DEPENDENT_ROOT_DECS = [
  'redactLogs',
  'redact',
  'preventLeaks',
  'encryptInjectedEnv',
  'disableProcessEnvInjection',
  'injectUndefinedAsEmpty',
  'proxyConfig',
  'proxy',
  'cache',
];
const BUILTIN_ROOT_DEC_NAMES = new Set(builtInRootDecorators.map((d) => d.name));
const CROSS_ITEM_WARNING_PREFIX = 'Value contains the sensitive value of ';

const itemsIn = (file: ParsedEnvSpecFile, from: number, to: number) => {
  const out: Array<ParsedEnvSpecConfigItem> = [];
  for (let i = from; i < to; i++) {
    const n = file.contents[i];
    if (n instanceof ParsedEnvSpecConfigItem) out.push(n);
  }
  return out;
};
const defOf = (node: ParsedEnvSpecConfigItem): ConfigItemDef => ({
  description: node.description,
  parsedValue: node.value,
  parsedDecorators: node.decoratorsArray,
});

/** key name -> items whose processing referred to it, built once and then patched */
function referrerIndex(graph: EnvGraph) {
  const g = graph as any;
  if (!g._referrers) {
    const idx = new Map<string, Set<string>>();
    for (const [key, refs] of graph._itemRefs) {
      for (const r of refs) {
        let s = idx.get(r);
        if (!s) idx.set(r, s = new Set());
        s.add(key);
      }
    }
    g._referrers = idx;
  }
  return g._referrers as Map<string, Set<string>>;
}

/**
 * What root decorators depend on (memoized; refused edits never change it):
 *  - `builtin`: keys built-in root decorators depend on, transitively. Their values decide how the graph loads
 *    (@currentEnv, @disable, @import(enabled=), @cache, ...), so editing one needs a rebuild
 *  - `named`: every key name any root decorator refers to, existing or not. Adding or removing such a key
 *    changes that decorator's processing (a plugin's init decorator only has its deps resolved in shape mode,
 *    so editing the value of a key it uses is fine)
 */
function rootDecDeps(graph: EnvGraph) {
  const g = graph as any;
  if (!g._rootDecDeps) {
    const builtinDirect: Array<string> = [];
    const named = new Set<string>();
    for (const source of graph.sortedDataSources) {
      for (const dec of source.rootDecorators) {
        const deps = dec.decValueResolver?.deps ?? [];
        for (const d of deps) named.add(d);
        if (BUILTIN_ROOT_DEC_NAMES.has(dec.name) || graph.mode !== 'shape') builtinDirect.push(...deps);
        for (const e of dec.schemaErrors) {
          const m = /invalid dependency: ([\w.-]+)/.exec(e.message);
          if (m) named.add(m[1]);
        }
      }
    }
    g._rootDecDeps = { builtin: graph.expandKeysWithTransitiveDeps(builtinDirect), named };
  }
  return g._rootDecDeps as { builtin: Set<string>, named: Set<string> };
}

/** configSchema keys in the order a full load registers them (each source's keys, then its imports, in order) */
function registrationOrder(graph: EnvGraph) {
  const order: Array<string> = [];
  const seen = new Set<string>();
  const visit = (s: EnvGraphDataSource) => {
    if (s.disabled) return;
    for (const k of Object.keys(s.configItemDefs)) {
      if (seen.has(k) || !s.isKeyImported(k)) continue;
      seen.add(k);
      order.push(k);
    }
    // children are unshifted as each import loads, so reversed they are in import order
    for (let i = s.children.length - 1; i >= 0; i--) visit(s.children[i]);
  };
  if (graph.rootDataSource) visit(graph.rootDataSource);
  return order;
}

const decText = (text: string, d: ParsedEnvSpecDecorator) => {
  const loc = (d.data as any)._location;
  return text.slice(loc.start.offset, loc.end.offset);
};

type Plan = {
  /** keys whose definitions changed */
  changed: Set<string>,
  added: Array<string>,
  removed: Array<string>,
  /** keys whose own definition objects are replaced (items edited in the file) */
  newDefs: Map<string, ParsedEnvSpecConfigItem>,
  /** the one source whose definitions of `changed` keys the edit is about */
  definingSource: EnvGraphDataSource,
  /** applied right after the source gets its new tree */
  mutateSource?: () => void,
};

/** an edit below the header: items of this file added, removed or changed */
function planItemEdit(
  graph: EnvGraph,
  source: DotEnvFileDataSource,
  edit: SourceEdit,
): Plan | string {
  for (let i = edit.newStart; i < edit.newEnd; i++) {
    const n: any = edit.file.contents[i];
    // a comment block that is not attached to an item: decorators in it are reported on the source
    if (!(n instanceof ParsedEnvSpecConfigItem) && n.data?.comments?.some((c: any) => c.decorators?.length)) {
      return 'edit adds decorators in a detached comment block';
    }
  }
  const oldItems = itemsIn(edit.oldFile, edit.oldStart, edit.oldEnd);
  const newItems = itemsIn(edit.file, edit.newStart, edit.newEnd);
  const oldKeys = new Set(oldItems.map((n) => n.key));
  const newKeys = new Set(newItems.map((n) => n.key));
  if (oldKeys.size !== oldItems.length || newKeys.size !== newItems.length) return 'duplicate key in the edit';
  const counts = (source as any)._keyCounts as Map<string, number> | undefined ?? new Map<string, number>();
  if (!(source as any)._keyCounts) {
    for (const n of edit.oldFile.configItems) counts.set(n.key, (counts.get(n.key) ?? 0) + 1);
    (source as any)._keyCounts = counts;
  }
  const changed = new Set([...oldKeys, ...newKeys]);
  for (const key of changed) {
    const outside = (counts.get(key) ?? 0) - (oldKeys.has(key) ? 1 : 0);
    if (outside > 0) return `key ${key} is defined more than once in the file`;
  }
  return {
    changed,
    added: [...newKeys].filter((k) => !oldKeys.has(k)),
    removed: [...oldKeys].filter((k) => !newKeys.has(k)),
    newDefs: new Map(newItems.map((n) => [n.key, n])),
    definingSource: source,
    mutateSource: () => {
      for (const k of oldKeys) counts.set(k, (counts.get(k) ?? 1) - 1);
      for (const k of newKeys) counts.set(k, (counts.get(k) ?? 0) + 1);
    },
  };
}

/** a header edit that only changes which keys one `@import` brings in (its pick/omit) */
async function planImportFilterEdit(
  graph: EnvGraph,
  source: DotEnvFileDataSource,
  edit: SourceEdit,
): Promise<Plan | string> {
  if (edit.lineDelta !== 0) return 'header edit changes lines';
  const oldDecs = edit.oldFile.decoratorsArray;
  const newDecs = edit.file.decoratorsArray;
  if (oldDecs.length !== newDecs.length || oldDecs.length !== source.rootDecorators.length) return 'header decorators changed';
  const oldText = source.rawContents!;
  let changedIdx = -1;
  for (let i = 0; i < oldDecs.length; i++) {
    const same = decText(oldText, oldDecs[i]) === decText(edit.rawContents, newDecs[i]);
    const oldLoc = (oldDecs[i].data as any)._location;
    const newLoc = (newDecs[i].data as any)._location;
    if (same && oldLoc.start.offset === newLoc.start.offset) continue;
    if (same || changedIdx !== -1) return 'header edit moves or changes more than one decorator';
    changedIdx = i;
  }
  if (changedIdx === -1) return 'header edit changes no decorator';
  const oldInst = source.rootDecorators[changedIdx];
  if (oldInst.name !== 'import' || newDecs[changedIdx].name !== 'import' || !oldInst.isFunctionCall) return 'header edit is not an @import';
  if (oldInst.schemaErrors.length) return '@import had errors';

  // process the new @import like _processImports does, without loading anything
  const newInst = new RootDecoratorInstance(source, newDecs[changedIdx]);
  await newInst.process();
  const oldArgs = oldInst.decValueResolver?.objArgs ?? {};
  const newArgs = newInst.decValueResolver?.objArgs ?? {};
  for (const k of new Set([...Object.keys(oldArgs), ...Object.keys(newArgs)])) {
    if (k !== 'pick' && k !== 'omit') {
      if (!oldArgs[k] || !newArgs[k] || !oldArgs[k].isStatic || !newArgs[k].isStatic
        || oldArgs[k].staticValue !== newArgs[k].staticValue) return `@import ${k} changed`;
    }
  }
  const importArgs = await newInst.resolve();
  if (newInst.schemaErrors.length || !importArgs) return 'new @import has errors';
  const oldImportArgs = await oldInst.resolve();
  if (importArgs.arr.length !== 1 || oldImportArgs?.arr?.[0] !== importArgs.arr[0]) return '@import path or positional keys changed';
  let importFilter;
  try {
    importFilter = parseKeyFilterArgs(newArgs.pick, newArgs.omit, '@import', { allowTagSelectors: true });
  } catch {
    return 'new @import filter is invalid';
  }
  // the source it loaded: the n-th import of this file
  const importDecs = source.rootDecorators.filter((d) => d.name === 'import' && d.isFunctionCall);
  const nth = importDecs.indexOf(oldInst);
  const imported = [...source.children].reverse().filter((c) => c.importMeta?.isImport);
  if (imported.length !== importDecs.length) return 'imports and loaded sources do not line up';
  const child = imported[nth];
  if (!(child instanceof DotEnvFileDataSource) || child.children.length) return 'import is not a single file';

  // which keys of that file are visible before and after
  const oldFilter = child.importMeta!.importFilter;
  const visible = () => new Set(Object.keys(child.configItemDefs).filter((k) => child.isKeyImported(k)));
  const before = visible();
  child.importMeta!.importFilter = importFilter;
  const after = visible();
  child.importMeta!.importFilter = oldFilter;
  const changed = new Set<string>();
  for (const k of before) if (!after.has(k)) changed.add(k);
  for (const k of after) if (!before.has(k)) changed.add(k);
  return {
    changed,
    added: [...after].filter((k) => !before.has(k)),
    removed: [...before].filter((k) => !after.has(k)),
    newDefs: new Map(),
    definingSource: child,
    mutateSource: () => {
      child.importMeta!.importFilter = importFilter;
      source.rootDecorators[changedIdx] = newInst;
      // the other root decorators keep their instances; point them at the new tree (same text and place)
      for (let i = 0; i < newDecs.length; i++) {
        if (i !== changedIdx) (source.rootDecorators[i] as any).parsedDecorator = newDecs[i];
      }
      delete (graph as any)._rootDecDeps;
    },
  };
}

export async function applyIncrementalSourceEdit(
  graph: EnvGraph,
  source: EnvGraphDataSource,
  edit: SourceEdit,
): Promise<IncrementalResult> {
  const refuse = (reason: string): IncrementalResult => ({ applied: false, reason, mutated: false });

  // ---- what the graph must look like
  if (!graph.configItemsProcessed || !graph._allResolved) return refuse('graph not fully loaded and resolved');
  if (!(source instanceof DotEnvFileDataSource) || source !== graph.rootDataSource) return refuse('not the root schema file');
  if (source.parsedFile !== edit.oldFile) return refuse('edit is not against the loaded tree');
  if (source._errors.length) return refuse('source has errors of its own');
  for (const s of graph.sortedDataSources) if (!s.isValid || s.disabled) return refuse('a source is invalid or disabled');
  for (const plugin of graph.plugins) if (plugin.loadingError) return refuse('plugin failed to load');
  if (graph._foundCycles) return refuse('graph has dependency cycles');
  const g = graph as any;
  if (g._hasBootItems === undefined) {
    g._hasBootItems = Object.values(graph.configSchema).some((item) => item.isBootDynamic);
    g._hasBuiltinItems = Object.values(graph.configSchema).some((item) => item.isBuiltin);
  }
  if (g._hasBootItems) return refuse('graph has @dynamic=boot items');
  for (const s of graph.sortedDataSources) {
    for (const dec of s.rootDecorators) {
      if (ERROR_STATE_DEPENDENT_ROOT_DECS.includes(dec.name)) return refuse(`graph has @${dec.name}`);
    }
  }

  // ---- what the edit changes
  const oldContents = edit.oldFile.contents;
  const firstItem = oldContents.findIndex((n) => n instanceof ParsedEnvSpecConfigItem);
  if (firstItem < 0) return refuse('file has no items');
  let plan: Plan | string;
  if (edit.oldStart > firstItem) plan = planItemEdit(graph, source, edit);
  else if (edit.oldEnd <= firstItem && edit.newEnd <= firstItem) plan = await planImportFilterEdit(graph, source, edit);
  else plan = 'edit spans the header and the items';
  if (typeof plan === 'string') return refuse(plan);
  const { changed, added, removed } = plan;

  const envFlagKeys = new Set(graph.sortedDataSources.map((s) => s.envFlagKey).filter(Boolean));
  const rootDeps = rootDecDeps(graph);
  for (const key of changed) {
    for (const s of graph.sortedDataSources) {
      if (s !== plan.definingSource && s.configItemDefs[key] !== undefined) return refuse(`key ${key} is also defined in ${s.label}`);
    }
    if (isBuiltinVar(key) || isVarlockReservedKey(key)) return refuse(`key ${key} is builtin or reserved`);
    if (envFlagKeys.has(key)) return refuse(`key ${key} is the current-env item`);
    if (rootDeps.builtin.has(key)) return refuse(`a built-in root decorator depends on ${key}`);
  }
  for (const key of [...added, ...removed]) {
    if (rootDeps.named.has(key)) return refuse(`a root decorator refers to ${key}, which is added or removed`);
  }
  if ((added.length || removed.length) && g._hasBuiltinItems) return refuse('keys added or removed in a graph with builtin items');

  // items to rebuild: the changed ones plus everything that refers to them, transitively
  const referrers = referrerIndex(graph);
  const rebuild = new Set<string>([...changed].filter((k) => !removed.includes(k)));
  const queue = [...changed];
  while (queue.length) {
    const k = queue.pop()!;
    for (const r of referrers.get(k) ?? []) {
      if (removed.includes(r) || rebuild.has(r)) continue;
      rebuild.add(r);
      queue.push(r);
    }
  }
  for (const k of rebuild) {
    if (rootDeps.builtin.has(k) || envFlagKeys.has(k)) return refuse(`a built-in root decorator depends on ${k}`);
  }
  const wasError = graph._rootDecProcessHasErrors || graph._itemProcessErrorKeys.size > 0;

  // ---- apply (from here on a refusal means the graph must be rebuilt)
  const fail = (reason: string): IncrementalResult => ({ applied: false, reason, mutated: true });
  source.parsedFile = edit.file;
  source.rawContents = edit.rawContents;
  plan.mutateSource?.();

  // definitions: unchanged keys keep their def objects (which hold their processed resolvers)
  if (plan.newDefs.size || removed.some((k) => source.configItemDefs[k])) {
    if (added.some((k) => plan.newDefs.has(k))) {
      const defs: Record<string, ConfigItemDef> = {};
      for (const n of edit.file.configItems) {
        defs[n.key] = plan.newDefs.has(n.key) ? defOf(plan.newDefs.get(n.key)!) : source.configItemDefs[n.key];
      }
      source.configItemDefs = defs;
    } else {
      for (const [k, n] of plan.newDefs) source.configItemDefs[k] = defOf(n);
      for (const k of removed) delete source.configItemDefs[k];
    }
  }

  // old reference edges of everything rebuilt or removed leave the index
  for (const k of [...rebuild, ...removed]) {
    for (const r of graph._itemRefs.get(k) ?? []) referrers.get(r)?.delete(k);
    graph._itemRefs.delete(k);
    graph._itemProcessErrorKeys.delete(k);
  }
  for (const k of removed) delete graph.configSchema[k];

  // fresh items; definitions that are not new get their resolvers and decorators rebuilt too
  const fresh = new Map<string, ConfigItem>();
  for (const k of rebuild) {
    const old = graph.configSchema[k];
    if (old) {
      for (const d of old.defs) {
        delete d.itemDef.resolver;
        delete d.itemDef.decorators;
      }
    }
    fresh.set(k, new ConfigItem(graph, k));
  }
  if (added.length) {
    const schema: Record<string, ConfigItem> = {};
    for (const k of registrationOrder(graph)) schema[k] = fresh.get(k) ?? graph.configSchema[k];
    // (removed keys are already gone from configSchema)
    const expected = Object.keys(graph.configSchema).length + added.length;
    if (Object.keys(schema).length !== expected || Object.values(schema).some((item) => !item)) {
      return fail('registration order does not cover the graph');
    }
    graph.configSchema = schema;
  } else {
    for (const [k, item] of fresh) graph.configSchema[k] = item;
  }
  const rebuildOrdered = Object.keys(graph.configSchema).filter((k) => fresh.has(k));
  // (sources and their order are unchanged; the structure memos only need the edited items' entries)
  for (const k of rebuildOrdered) {
    for (const d of graph.configSchema[k].defs) {
      delete d.itemDef.resolver;
      delete d.itemDef.decorators;
    }
  }

  // process, like finishLoad does
  for (const k of rebuildOrdered) {
    const item = graph.configSchema[k];
    await item.process();
    if (item.errors.some((e) => !e.isWarning)) graph._itemProcessErrorKeys.add(k);
    if (item.isBootDynamic) return fail('edit adds a @dynamic=boot item');
    for (const r of graph._itemRefs.get(k) ?? []) {
      let s = referrers.get(r);
      if (!s) referrers.set(r, s = new Set());
      s.add(k);
    }
  }
  const adj = g._graphAdjacencyListMemo as Record<string, Array<string>> | undefined;
  if (adj) {
    if (added.length) {
      // keep the memo's key order the same as a fresh build would have
      const next: Record<string, Array<string>> = {};
      for (const k in graph.configSchema) next[k] = fresh.has(k) ? graph.configSchema[k].dependencyKeys : adj[k];
      g._graphAdjacencyListMemo = next;
    } else {
      for (const k of removed) delete adj[k];
      for (const k of rebuildOrdered) adj[k] = graph.configSchema[k].dependencyKeys;
    }
  }
  const isError = graph._rootDecProcessHasErrors || graph._itemProcessErrorKeys.size > 0;

  // finishLoad's checks that only run on a schema without errors
  if (!isError) {
    if (wasError) {
      if (findGraphCycles(graph.graphAdjacencyList).length) return fail('edit leaves a dependency cycle');
    } else {
      // the old graph had none, so a new cycle goes through a rebuilt item
      const adjList = graph.graphAdjacencyList;
      for (const start of rebuildOrdered) {
        const seen = new Set<string>();
        const stack = [...adjList[start] ?? []];
        while (stack.length) {
          const k = stack.pop()!;
          if (k === start) return fail('edit adds a dependency cycle');
          if (seen.has(k)) continue;
          seen.add(k);
          stack.push(...adjList[k] ?? []);
        }
      }
    }
  }

  // cross-item warnings (a sensitive value inside a public one) are recomputed over the whole graph below,
  // so drop the old ones first; remember who had one
  const touched = new Set(rebuildOrdered);
  for (const k in graph.configSchema) {
    const item = graph.configSchema[k];
    if (fresh.has(k) || !item.validationErrors?.length) continue;
    const kept = item.validationErrors.filter((e) => !e.message.startsWith(CROSS_ITEM_WARNING_PREFIX));
    if (kept.length !== item.validationErrors.length) {
      item.validationErrors = kept;
      touched.add(k);
    }
  }
  // resolveEnvValues re-runs the cross-item check at its end, but returns early when given no keys
  if (rebuildOrdered.length) await graph.resolveEnvValues(rebuildOrdered);
  else g.checkForSensitiveValuesInsideNonSensitiveOnes();
  graph._allResolved = true;
  for (const k in graph.configSchema) {
    const errs = graph.configSchema[k].validationErrors;
    if (errs?.some((e) => e.message.startsWith(CROSS_ITEM_WARNING_PREFIX))) touched.add(k);
  }

  return {
    applied: true,
    rebuiltKeys: rebuildOrdered,
    addedKeys: added,
    removedKeys: removed,
    touchedKeys: [...touched],
  };
}
