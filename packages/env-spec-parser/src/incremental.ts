import { ParsedEnvSpecFile } from './classes.js';
// @ts-ignore
import * as peggyParser from './grammar.js';

/**
 * Result of {@link reparseEnvSpecIncremental}: the new file, plus which top-level nodes were replaced.
 * `contents[newStart, newEnd)` of the new file replaced `contents[oldStart, oldEnd)` of the old one; every
 * other node is the old node object itself (nodes after the edit had their locations shifted in place).
 */
export type IncrementalParseResult = {
  file: ParsedEnvSpecFile;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  /** nodes parsed for this edit (including the one re-checked before it) */
  nodesParsed: number;
  /** lines added (negative: removed) by the edit */
  lineDelta: number;
  /** first line (1-based, old numbering) of the old text after the edit that was kept; lines from here moved by lineDelta */
  oldResumeLine: number;
};

type PegLibraryResult = {
  peg$result: any;
  peg$currPos: number;
  peg$FAILED: any;
  peg$maxFailPos: number;
};

/** parse one top-level node of `text` at `pos`; positions in the result are relative to `text` */
function parseNodeAt(text: string, pos: number) {
  const r: PegLibraryResult = peggyParser.parse(text, { startRule: 'EnvSpecNode', peg$library: true, peg$currPos: pos });
  if (r.peg$result === r.peg$FAILED) return undefined;
  return { node: r.peg$result, end: r.peg$currPos, maxFailPos: r.peg$maxFailPos };
}

/** length of the common prefix of a and b, compared in chunks (string equality is a memcmp) */
function commonPrefix(a: string, b: string) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  for (let step = 4096; step >= 1; step = step === 1 ? 0 : Math.max(1, Math.floor(step / 8))) {
    while (i + step <= max && a.substring(i, i + step) === b.substring(i, i + step)) i += step;
    if (step === 1) break;
  }
  return i;
}
function commonSuffix(a: string, b: string, limit: number) {
  const max = Math.min(a.length, b.length, limit);
  let i = 0;
  for (let step = 4096; step >= 1; step = step === 1 ? 0 : Math.max(1, Math.floor(step / 8))) {
    while (
      i + step <= max
      && a.substring(a.length - i - step, a.length - i) === b.substring(b.length - i - step, b.length - i)
    ) i += step;
    if (step === 1) break;
  }
  return i;
}

const countNewlines = (s: string, from: number, to: number) => {
  let n = 0;
  for (let i = s.indexOf('\n', from); i !== -1 && i < to; i = s.indexOf('\n', i + 1)) n++;
  return n;
};

let shiftEpoch = 0;
/** shift every `_location` under a parsed node (offsets and lines; columns are unchanged since nodes start a line) */
export function shiftNodeLocations(root: any, dOffset: number, dLine: number) {
  if (!dOffset && !dLine) return;
  // objects can be reachable twice (expand() keeps the raw value next to the expanded one), so each location is
  // stamped with the pass that moved it, which is cheaper than a visited set
  const epoch = ++shiftEpoch;
  const walk = (v: any) => {
    if (Array.isArray(v)) {
      for (const x of v) {
        if (x && typeof x === 'object') walk(x);
      }
      return;
    }
    const loc = v._location;
    if (loc && loc._shifted !== epoch) {
      loc._shifted = epoch;
      loc.start.offset += dOffset;
      loc.start.line += dLine;
      loc.end.offset += dOffset;
      loc.end.line += dLine;
    }
    for (const k in v) {
      if (k === '_location') continue;
      const x = v[k];
      if (x && typeof x === 'object') walk(x);
    }
  };
  walk(root);
}

/** move a node parsed from `text.slice(base)` to absolute positions (base is a line start on line `baseLine`) */
const rebase = (node: any, base: number, baseLine: number) => shiftNodeLocations(node, base, baseLine - 1);

/**
 * Reparse only what an edit touched. `prev` must be the tree of `prevText` (as returned by
 * parseEnvSpecDotEnvFile or by this function); it is consumed: nodes after the edit are reused and their
 * locations shifted in place. Returns undefined when the edit cannot be handled locally (CRLF text, a parse
 * error near the edit): parse the whole text instead, which also produces the proper error.
 *
 * Exact by construction: the grammar has no lookbehind, so a node parsed at a position of the full new text is
 * the node a full parse makes there, and parsing restarts from the old node boundary nearest the edit whose
 * previous node never looked past it (checked by reparsing that node and reading the furthest position it
 * probed). It stops at the first old node boundary after the edit, from where the old nodes are the same text.
 */
export function reparseEnvSpecIncremental(
  prev: ParsedEnvSpecFile,
  prevText: string,
  nextText: string,
): IncrementalParseResult | undefined {
  if (prevText.includes('\r') || nextText.includes('\r')) return undefined;
  const nodes = prev.contents as Array<any>;
  if (!nodes.length) return undefined;
  const p = commonPrefix(prevText, nextText);
  if (p === prevText.length && p === nextText.length) {
    return {
      file: prev, oldStart: 0, oldEnd: 0, newStart: 0, newEnd: 0, nodesParsed: 0, lineDelta: 0, oldResumeLine: Infinity,
    };
  }
  const sfx = commonSuffix(prevText, nextText, Math.min(prevText.length, nextText.length) - p);
  const newChangeEnd = nextText.length - sfx;
  const delta = nextText.length - prevText.length;

  const startOf = (n: any) => n.data._location.start.offset as number;
  const endOf = (n: any) => n.data._location.end.offset as number;
  // first node that ends after the change start (an insertion at a boundary belongs to the node after it)
  let lo = 0;
  let hi = nodes.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (endOf(nodes[mid]) <= p) lo = mid + 1;
    else hi = mid;
  }
  let j = Math.min(lo, nodes.length - 1);
  let nodesParsed = 0;
  // step back while the node before j looked at text at or after the change (failed alternatives probe ahead).
  // Only the nodes right before the edit are checked: a node further back that probed past the edit (possible
  // only when a failed alternative scanned across lines, e.g. an unclosed quote the grammar then read another
  // way) is not detected
  while (j > 0) {
    const before = nodes[j - 1];
    const base = startOf(before);
    const r = parseNodeAt(prevText.slice(base), 0);
    nodesParsed++;
    if (!r) return undefined;
    // predicates fail silently (not in maxFailPos) but only ever look within the current line
    const probed = base + Math.max(r.maxFailPos, r.end - 1);
    const lineEnd = prevText.indexOf('\n', probed);
    const horizon = lineEnd === -1 ? prevText.length : lineEnd;
    if (horizon < p) break;
    j--;
  }
  const ws = j < nodes.length ? startOf(nodes[j]) : prevText.length;
  const wsLine = j < nodes.length ? nodes[j].data._location.start.line as number : 1;

  // old node starts, to find where the new parse lines up with the old one again
  const parsed: Array<any> = [];
  const sub = nextText.slice(ws);
  let pos = 0;
  let k = -1; // old index to resume at
  while (ws + pos < nextText.length) {
    const abs = ws + pos;
    if (abs >= newChangeEnd) {
      const oldAbs = abs - delta;
      // binary search an old node starting exactly at oldAbs
      let a = j;
      let b = nodes.length;
      while (a < b) {
        const m = Math.floor((a + b) / 2);
        if (startOf(nodes[m]) < oldAbs) a = m + 1;
        else b = m;
      }
      if (a < nodes.length && startOf(nodes[a]) === oldAbs) {
        k = a;
        break;
      }
    }
    const r = parseNodeAt(sub, pos);
    nodesParsed++;
    if (!r || r.end === pos) return undefined;
    rebase(r.node, ws, wsLine);
    parsed.push(r.node);
    pos = r.end;
  }
  if (k === -1) k = nodes.length;
  let dLine = 0;
  let oldResumeLine = Infinity;
  if (k < nodes.length) {
    // lines added by the edit, between the restart point and the resync point
    const syncOld = startOf(nodes[k]);
    oldResumeLine = nodes[k].data._location.start.line;
    dLine = countNewlines(nextText, ws, syncOld + delta) - countNewlines(prevText, ws, syncOld);
    for (let i = k; i < nodes.length; i++) shiftNodeLocations(nodes[i], delta, dLine);
  }
  const contents = [...nodes.slice(0, j), ...parsed, ...nodes.slice(k)];
  return {
    file: new ParsedEnvSpecFile(contents as any),
    oldStart: j,
    oldEnd: k,
    newStart: j,
    newEnd: j + parsed.length,
    nodesParsed,
    lineDelta: dLine,
    oldResumeLine,
  };
}
