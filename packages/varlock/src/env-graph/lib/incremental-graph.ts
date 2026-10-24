/**
 * Experiment (lsp-incremental-experiment): update a loaded and resolved EnvGraph in place after an edit to the
 * root schema file, re-processing and re-resolving only the edited items and the items that refer to them.
 *
 * The contract is that the graph ends up exactly as a full rebuild of the new text would leave it, for every
 * diagnostic an editor shows. Anything this cannot do exactly is refused up front (the caller rebuilds the
 * graph instead): edits to the header (root decorators, imports), to the current-env item or anything a root
 * decorator depends on, builtin and reserved keys, duplicate keys, keys also defined in another file, graphs
 * with dependency cycles or `@dynamic=boot` items, and graph-level root decorators whose result depends on
 * whether the schema has errors.
 */
import { ParsedEnvSpecConfigItem, type ParsedEnvSpecFile } from '@env-spec/parser';
import { ConfigItem, type ConfigItemDef } from './config-item';
import { DotEnvFileDataSource, type EnvGraphDataSource } from './data-source';
import type { EnvGraph } from './env-graph';
import { findGraphCycles } from './graph-utils';
import { isBuiltinVar } from './builtin-vars';
import { isVarlockReservedKey } from './reserved-vars';

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

/** keys the root decorators of every source depend on, transitively (memoized; refused edits never change it) */
function rootDecClosure(graph: EnvGraph) {
  const g = graph as any;
  if (!g._rootDecClosure) {
    const direct: Array<string> = [];
    for (const source of graph.sortedDataSources) {
      for (const dec of source.rootDecorators) direct.push(...dec.decValueResolver?.deps ?? []);
    }
    const closure = graph.expandKeysWithTransitiveDeps(direct);
    // names a root decorator referred to that did not exist (an added key could satisfy them)
    for (const source of graph.sortedDataSources) {
      for (const dec of source.rootDecorators) {
        for (const e of dec.schemaErrors) {
          const m = /invalid dependency: ([\w.-]+)/.exec(e.message);
          if (m) closure.add(m[1]);
        }
      }
    }
    g._rootDecClosure = closure;
  }
  return g._rootDecClosure as Set<string>;
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
  if ((graph as any)._hasBootItems === undefined) {
    (graph as any)._hasBootItems = Object.values(graph.configSchema).some((item) => item.isBootDynamic);
  }
  if ((graph as any)._hasBootItems) return refuse('graph has @dynamic=boot items');
  for (const s of graph.sortedDataSources) {
    for (const dec of s.rootDecorators) {
      if (ERROR_STATE_DEPENDENT_ROOT_DECS.includes(dec.name)) return refuse(`graph has @${dec.name}`);
    }
  }

  // ---- what the edit may touch
  const oldContents = edit.oldFile.contents;
  const firstItem = oldContents.findIndex((n) => n instanceof ParsedEnvSpecConfigItem);
  if (firstItem < 0 || edit.oldStart <= firstItem) return refuse('edit touches the header');
  for (let i = edit.newStart; i < edit.newEnd; i++) {
    const n: any = edit.file.contents[i];
    // a comment block that is not attached to an item: decorators in it are reported on the source
    if (!(n instanceof ParsedEnvSpecConfigItem) && n.data?.comments?.some((c: any) => c.decorators?.length)) {
      return refuse('edit adds decorators in a detached comment block');
    }
  }
  const oldItems = itemsIn(edit.oldFile, edit.oldStart, edit.oldEnd);
  const newItems = itemsIn(edit.file, edit.newStart, edit.newEnd);
  const oldKeys = new Set(oldItems.map((n) => n.key));
  const newKeys = new Set(newItems.map((n) => n.key));
  if (oldKeys.size !== oldItems.length || newKeys.size !== newItems.length) return refuse('duplicate key in the edit');
  // keys defined in more than one place: in this file (outside the edit) or in another source
  const counts = (source as any)._keyCounts as Map<string, number> | undefined
    ?? new Map<string, number>();
  if (!(source as any)._keyCounts) {
    for (const n of edit.oldFile.configItems) counts.set(n.key, (counts.get(n.key) ?? 0) + 1);
    (source as any)._keyCounts = counts;
  }
  const changed = new Set([...oldKeys, ...newKeys]);
  const envFlagKeys = new Set(graph.sortedDataSources.map((s) => s.envFlagKey).filter(Boolean));
  const closure = rootDecClosure(graph);
  for (const key of changed) {
    const outside = (counts.get(key) ?? 0) - (oldKeys.has(key) ? 1 : 0);
    if (outside > 0) return refuse(`key ${key} is defined more than once in the file`);
    for (const s of graph.sortedDataSources) {
      if (s !== source && (s as any).configItemDefs?.[key]) return refuse(`key ${key} is also defined in ${s.label}`);
    }
    if (isBuiltinVar(key) || isVarlockReservedKey(key)) return refuse(`key ${key} is builtin or reserved`);
    if (envFlagKeys.has(key)) return refuse(`key ${key} is the current-env item`);
    if (closure.has(key)) return refuse(`a root decorator depends on ${key}`);
  }
  const added = [...newKeys].filter((k) => !oldKeys.has(k));
  const removed = [...oldKeys].filter((k) => !newKeys.has(k));

  // items to rebuild: the edited ones plus everything that refers to them, transitively
  const referrers = referrerIndex(graph);
  const rebuild = new Set<string>([...newKeys]);
  const queue = [...changed];
  while (queue.length) {
    const k = queue.pop()!;
    for (const r of referrers.get(k) ?? []) {
      if (removed.includes(r) || rebuild.has(r)) continue;
      rebuild.add(r);
      queue.push(r);
    }
  }
  for (const k of rebuild) if (closure.has(k) || envFlagKeys.has(k)) return refuse(`a root decorator depends on ${k}`);
  const wasError = graph._rootDecProcessHasErrors || graph._itemProcessErrorKeys.size > 0;

  // ---- apply (from here on a refusal means the graph must be rebuilt)
  const fail = (reason: string): IncrementalResult => ({ applied: false, reason, mutated: true });
  source.parsedFile = edit.file;
  source.rawContents = edit.rawContents;
  for (const k of oldKeys) counts.set(k, (counts.get(k) ?? 1) - 1);
  for (const k of newKeys) counts.set(k, (counts.get(k) ?? 0) + 1);
  const newNodes = new Map(newItems.map((n) => [n.key, n]));

  // definitions: unchanged keys keep their def objects (which hold their processed resolvers)
  if (added.length) {
    const defs: Record<string, ConfigItemDef> = {};
    for (const n of edit.file.configItems) defs[n.key] = newNodes.has(n.key) ? defOf(n) : source.configItemDefs[n.key];
    source.configItemDefs = defs;
  } else {
    for (const [k, n] of newNodes) source.configItemDefs[k] = defOf(n);
    for (const k of removed) delete source.configItemDefs[k];
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
    // registration order of a full load: this file's keys in file order, then keys only in imports
    const schema: Record<string, ConfigItem> = {};
    for (const k in source.configItemDefs) schema[k] = fresh.get(k) ?? graph.configSchema[k];
    for (const k in graph.configSchema) if (!(k in schema)) schema[k] = graph.configSchema[k];
    graph.configSchema = schema;
  } else {
    for (const [k, item] of fresh) graph.configSchema[k] = item;
  }
  const rebuildOrdered = Object.keys(graph.configSchema).filter((k) => fresh.has(k));

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
  const adj = (graph as any)._graphAdjacencyListMemo as Record<string, Array<string>> | undefined;
  if (adj) {
    for (const k of removed) delete adj[k];
    // keep the memo's key order the same as a fresh build would have
    if (added.length) {
      const next: Record<string, Array<string>> = {};
      for (const k in graph.configSchema) next[k] = fresh.has(k) ? graph.configSchema[k].dependencyKeys : adj[k];
      (graph as any)._graphAdjacencyListMemo = next;
    } else {
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
  await graph.resolveEnvValues(rebuildOrdered);
  graph._allResolved = true;
  for (const k in graph.configSchema) {
    const errs = graph.configSchema[k].validationErrors;
    if (errs?.some((e) => e.message.startsWith(CROSS_ITEM_WARNING_PREFIX))) touched.add(k);
  }
  for (const k of removed) touched.delete(k);

  return {
    applied: true,
    rebuiltKeys: rebuildOrdered,
    addedKeys: added,
    removedKeys: removed,
    touchedKeys: [...touched],
  };
}
