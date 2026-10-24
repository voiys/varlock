/**
 * Shape mode reads schemas nobody has reviewed, and a schema can supply a regex with catastrophic
 * backtracking (`regex("^(a+)+$")`) that blocks the thread for minutes. JS regexes run on the main
 * thread, so no timer can interrupt one. In shape mode every schema-supplied regex therefore runs on
 * RE2JS, a linear-time engine, through `ShapeRegExp`, a RegExp whose `exec()` (and so `test()`,
 * `String.prototype.match` and the rest) delegates to RE2.
 *
 * RE2 has no backreferences or lookaround, and a few constructs mean something else there. The pattern is
 * translated so a match means the same as in JS; a pattern that cannot be translated exactly, or an input
 * that would be read differently (astral characters without the `u` flag), is UNKNOWN: `exec()` reports a
 * match, so validation reports no error, and the skip is recorded in the graph's `shapeSkipped`.
 * Default mode never uses this.
 */
import type { RE2JS as RE2JSClass } from 're2js';
import { REGEX_LIKE_STRING } from './regex-like-string';

let RE2JS: typeof RE2JSClass | undefined;

/** loads the engine once per process (a separate chunk, so default mode never loads it) */
export async function loadShapeRegexEngine() {
  RE2JS ||= (await import('re2js')).RE2JS;
}

// JS `\s`: WhiteSpace and LineTerminator (RE2's `\s` is ASCII only)
const JS_SPACE_RANGES = '\\t\\n\\x{0B}\\f\\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}';
// JS `.` without the `s` flag excludes every line terminator (RE2's excludes only `\n`)
const JS_DOT = '[^\\n\\r\\x{2028}\\x{2029}]';
const HEX = /^[0-9a-fA-F]$/;

class Untranslatable extends Error {}

/**
 * Translates a JS pattern to an RE2 pattern with the same meaning, or throws `Untranslatable`.
 * Deliberately conservative: anything not known to mean the same in both engines is refused.
 */
function translate(source: string, flags: string): string {
  const unicode = flags.includes('u');
  if (flags.includes('v')) throw new Untranslatable('the v flag');
  let out = '';
  let inClass = false;
  let classStart = false;
  let hasAnchor = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\') {
      const n = source[++i];
      if (n === undefined) throw new Untranslatable('trailing backslash');
      if ('dDwWtnrf'.includes(n)) out += `\\${n}`;
      else if (n === 'b') out += inClass ? '\\x{08}' : '\\b';
      else if (n === 'B') {
        if (inClass) throw new Untranslatable('\\B in a class');
        out += '\\B';
      } else if (n === 'v') out += '\\x{0B}';
      else if (n === 's') out += inClass ? JS_SPACE_RANGES : `[${JS_SPACE_RANGES}]`;
      else if (n === 'S') {
        if (inClass) throw new Untranslatable('\\S in a class');
        out += `[^${JS_SPACE_RANGES}]`;
      } else if (n === '0' && !/[0-9]/.test(source[i + 1] ?? '')) out += '\\x{00}';
      else if (n >= '0' && n <= '9') throw new Untranslatable('a backreference or octal escape');
      else if (n === 'x' && HEX.test(source[i + 1] ?? '') && HEX.test(source[i + 2] ?? '')) {
        out += `\\x{${source.slice(i + 1, i + 3)}}`;
        i += 2;
      } else if (n === 'u' && unicode && source[i + 1] === '{') {
        const end = source.indexOf('}', i);
        if (end === -1) throw new Untranslatable('bad \\u{...}');
        out += `\\x{${source.slice(i + 2, end)}}`;
        i = end;
      } else if (n === 'u' && [1, 2, 3, 4].every((k) => HEX.test(source[i + k] ?? ''))) {
        out += `\\x{${source.slice(i + 1, i + 5)}}`;
        i += 4;
      } else if ((n === 'p' || n === 'P') && unicode) {
        // same meaning for general categories (`\p{L}`); anything RE2 does not know fails to compile
        out += `\\${n}`;
      } else if (/[a-zA-Z]/.test(n)) {
        // `\c`, `\k` and the like are syntax; without the u flag any other letter is itself (JS identity escape)
        if (unicode || 'ckxu'.includes(n)) throw new Untranslatable(`\\${n}`);
        out += n;
      } else if (/[!-/:-@[-`{-~]/.test(n)) out += `\\${n}`; // ASCII punctuation: a literal in both
      else out += `\\x{${n.codePointAt(0)!.toString(16)}}`;
      classStart = false;
      continue;
    }
    if (inClass) {
      // JS `[]` matches nothing; RE2 reads `]` there as a literal
      if (classStart && c === ']') throw new Untranslatable('an empty class');
      classStart = false;
      if (c === ']') inClass = false;
      if (c === '[') out += '\\['; // RE2 reads `[:alpha:]` in a class, JS reads a literal `[`
      else out += c;
      continue;
    }
    if (c === '[') {
      inClass = true;
      classStart = true;
      out += c;
      if (source[i + 1] === '^') {
        out += '^';
        i++;
      }
      continue;
    }
    if (c === '(' && source[i + 1] === '?') {
      if (source[i + 2] === ':') {
        out += '(?:';
        i += 2;
      } else if (source[i + 2] === '<' && /[A-Za-z_$]/.test(source[i + 3] ?? '')) {
        out += '(?P<';
        i += 2;
      } else {
        throw new Untranslatable('lookaround or an inline modifier');
      }
      continue;
    }
    if (c === '.') {
      out += flags.includes('s') ? '(?s:.)' : JS_DOT;
      continue;
    }
    if (c === '^' || c === '$') hasAnchor = true;
    out += c;
  }
  // with `m`, JS anchors also match around \r, \u2028 and \u2029; RE2's only around \n
  if (flags.includes('m') && hasAnchor) throw new Untranslatable('^ or $ with the m flag');
  return out;
}

const SURROGATE = /[\uD800-\uDFFF]/;

/**
 * Compiled RE2 programs (or why a pattern cannot be compiled), by flags and source. A program is
 * immutable and each match makes its own matcher, so one program serves every regex with that pattern.
 */
const compiledPrograms = new Map<string, { re2?: RE2JSClass, untranslatable?: string }>();
const MAX_COMPILED_PROGRAMS = 1000;
function compileProgram(source: string, flags: string) {
  const key = `${flags}/${source}`;
  let compiled = compiledPrograms.get(key);
  if (!compiled) {
    try {
      // eslint-disable-next-line no-bitwise
      const re2Flags = (flags.includes('i') ? RE2JS!.CASE_INSENSITIVE : 0)
        | (flags.includes('m') ? RE2JS!.MULTILINE : 0);
      compiled = { re2: RE2JS!.compile(translate(source, flags), re2Flags) };
    } catch (err) {
      compiled = { untranslatable: (err as Error).message };
    }
    // schemas are re-read for as long as the process runs: keep the cache from growing without bound
    if (compiledPrograms.size >= MAX_COMPILED_PROGRAMS) compiledPrograms.clear();
    compiledPrograms.set(key, compiled);
  }
  return compiled;
}

/** A RegExp that runs on RE2 (linear time). See the module comment. */
export class ShapeRegExp extends RegExp {
  private _re2?: RE2JSClass;
  /** why this pattern cannot be run exactly on RE2, if it cannot */
  readonly untranslatable?: string;
  /** called each time a match is unknown (records the skip on the graph) */
  onUnknown?: (reason: string) => void;
  private readonly _display?: string;

  constructor(source: string, flags?: string, opts?: { display?: string, onUnknown?: (reason: string) => void }) {
    super(source, flags); // JS syntax errors surface exactly as in default mode
    this._display = opts?.display;
    this.onUnknown = opts?.onUnknown;
    if (!RE2JS) {
      this.untranslatable = 'the regex engine is not loaded';
    } else {
      ({ re2: this._re2, untranslatable: this.untranslatable } = compileProgram(this.source, this.flags));
    }
  }

  /** whether a match against this input is unknown (and why), without recording anything */
  unknownReasonFor(input: string): string | undefined {
    if (this.untranslatable) return this.untranslatable;
    if (!this.unicode && SURROGATE.test(input)) return 'astral characters without the u flag';
  }

  /**
   * Like `test()`, but undefined when the match is unknown (and then `onUnknown` is called), so a
   * caller can tell an unknown match from a real one
   */
  testKnown(input: string): boolean | undefined {
    const reason = this.unknownReasonFor(input);
    if (reason !== undefined) {
      this.onUnknown?.(reason);
      return undefined;
    }
    return this.find(input) !== null;
  }

  test(input: string): boolean {
    // unknown: report a match, so nothing is reported as invalid
    return this.testKnown(String(input)) ?? true;
  }

  exec(input: string): RegExpExecArray | null {
    const str = String(input);
    const reason = this.unknownReasonFor(str);
    if (reason !== undefined) {
      this.onUnknown?.(reason);
      // unknown: report a match, so nothing is reported as invalid
      const fake = [str] as unknown as RegExpExecArray;
      fake.index = 0;
      fake.input = str;
      return fake;
    }
    const m = this.find(str);
    if (!m) return null;
    const groups: Array<string | undefined> = [];
    for (let g = 0; g <= m.groupCount(); g++) groups.push(m.group(g) ?? undefined);
    const result = groups as unknown as RegExpExecArray;
    result.index = m.start();
    result.input = str;
    return result;
  }

  /** runs RE2 on an input known to be readable, updating `lastIndex` as exec() does. The matcher, or null */
  private find(str: string) {
    const stateful = this.global || this.sticky;
    const start = stateful ? this.lastIndex : 0;
    if (start > str.length) {
      this.lastIndex = 0;
      return null;
    }
    const m = this._re2!.matcher(str);
    if (!m.find(start) || (this.sticky && m.start() !== start)) {
      if (stateful) this.lastIndex = 0;
      return null;
    }
    if (stateful) this.lastIndex = m.end();
    return m;
  }

  toString() {
    return this._display ?? super.toString();
  }
}

/**
 * The regex a schema value describes, as an ShapeRegExp: a RegExp (from `regex()`), a `/pattern/flags`
 * string, or a plain pattern string (the same reading `string(matches=...)` gives a string in default mode).
 */
export function toShapeRegExp(
  value: RegExp | string,
  onUnknown?: (reason: string) => void,
): ShapeRegExp {
  if (value instanceof ShapeRegExp) return value;
  if (value instanceof RegExp) return new ShapeRegExp(value.source, value.flags, { onUnknown });
  const literal = value.match(REGEX_LIKE_STRING);
  if (literal) {
    try {
      return new ShapeRegExp(literal[1], literal[2], { display: value, onUnknown });
    } catch {
      // not a valid regex literal: default mode then reads the whole string as a pattern
    }
  }
  return new ShapeRegExp(value, undefined, { display: value, onUnknown });
}
