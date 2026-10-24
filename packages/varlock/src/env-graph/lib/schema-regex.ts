/**
 * A schema can supply a regex with catastrophic backtracking (`regex("^(a+)+$")`) that blocks the thread
 * for minutes. JS regexes run on the main thread, so no timer can interrupt one. Every schema-supplied regex
 * (`regex()`, `matches`, the patterns `remap()` compares against) therefore runs on RE2JS, a linear-time
 * engine, through `SchemaRegExp`, a RegExp whose `exec()` (and so `test()`, `String.prototype.match` and
 * the rest) delegates to RE2.
 *
 * RE2 has no backreferences or lookaround, and a few constructs mean something else there. The pattern is
 * translated so a match means the same as in JS. A pattern that cannot be translated exactly is
 * UNSUPPORTED (`unsupported` says why), and an input that would be read differently (astral characters
 * without the `u` flag) cannot be matched on RE2 either. What happens then depends on the mode:
 * - default mode (the user's own project) runs that match on the JS engine, as before. An unsupported
 *   pattern gets a warning saying this fallback will be removed (see `unsupportedRegexWarning`)
 * - shape mode never runs the JS engine: the match is UNKNOWN. `exec()` reports a match, so validation
 *   reports no error, the item gets a warning, and the skip is recorded in the graph's `shapeSkipped`
 */
import type { RE2JS as RE2JSClass } from 're2js';
import { REGEX_LIKE_STRING } from './regex-like-string';
import { SchemaError } from './errors';

let RE2JS: typeof RE2JSClass | undefined;

/** loads the engine once per process (a separate chunk, loaded when a graph gets its root data source) */
export async function loadSchemaRegexEngine() {
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
      else if (n >= '0' && n <= '9') throw new Untranslatable('a backreference (or an octal escape)');
      else if (n === 'k' && source[i + 1] === '<') throw new Untranslatable('a named backreference');
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
      } else if (source[i + 2] === '=' || source[i + 2] === '!') {
        throw new Untranslatable('lookahead');
      } else if (source[i + 2] === '<' && (source[i + 3] === '=' || source[i + 3] === '!')) {
        throw new Untranslatable('lookbehind');
      } else {
        throw new Untranslatable('an inline modifier');
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
const compiledPrograms = new Map<string, { re2?: RE2JSClass, unsupported?: string }>();
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
      compiled = {
        unsupported: err instanceof Untranslatable
          ? err.message
          : `syntax it cannot compile (${(err as Error).message})`,
      };
    }
    // schemas are re-read for as long as the process runs: keep the cache from growing without bound
    if (compiledPrograms.size >= MAX_COMPILED_PROGRAMS) compiledPrograms.clear();
    compiledPrograms.set(key, compiled);
  }
  return compiled;
}

type SchemaRegExpOpts = {
  /** how the regex is shown (by default its `/source/flags`) */
  display?: string,
  /**
   * default mode: a match RE2 cannot evaluate exactly runs on the JS engine instead. Without it (shape
   * mode) the match is unknown
   */
  fallbackToJs?: boolean,
  /** shape mode: called each time a match is unknown (records the skip on the graph) */
  onUnknown?: (reason: string) => void,
};

/** A RegExp that runs on RE2 (linear time). See the module comment. */
export class SchemaRegExp extends RegExp {
  private _re2?: RE2JSClass;
  /** the feature RE2 does not support that keeps this pattern off it (e.g. `lookahead`), if any */
  readonly unsupported?: string;
  readonly fallbackToJs: boolean;
  onUnknown?: (reason: string) => void;
  private readonly _display?: string;
  /** the last input checked for astral characters, so a global regex walking one input checks it once */
  private _lastInput?: string;
  private _lastInputHasAstral = false;

  constructor(source: string | RegExp, flags?: string, opts?: SchemaRegExpOpts) {
    super(source, flags); // JS syntax errors surface exactly as on the JS engine
    // a copy (`new SchemaRegExp(re, flags)`, or a species copy made by `matchAll()` / `split()`) keeps the options
    const from = source instanceof SchemaRegExp ? source : undefined;
    this._display = opts?.display ?? (from && from.flags === this.flags ? from._display : undefined);
    this.fallbackToJs = opts?.fallbackToJs ?? from?.fallbackToJs ?? false;
    this.onUnknown = opts?.onUnknown ?? from?.onUnknown;
    if (RE2JS) {
      ({ re2: this._re2, unsupported: this.unsupported } = compileProgram(this.source, this.flags));
    }
  }

  /** whether a match against this input cannot run on RE2 (and why) */
  private re2UnavailableFor(input: string): string | undefined {
    if (!RE2JS) return 'the regex engine is not loaded';
    if (this.unsupported) return this.unsupported;
    if (this.unicode) return undefined;
    if (input !== this._lastInput) {
      this._lastInput = input;
      this._lastInputHasAstral = SURROGATE.test(input);
    }
    if (this._lastInputHasAstral) return 'astral characters without the u flag';
  }

  /**
   * Like `test()`, but undefined when the match is unknown (and then `onUnknown` is called), so a
   * caller can tell an unknown match from a real one. Never undefined with `fallbackToJs`
   */
  testKnown(input: string): boolean | undefined {
    const reason = this.re2UnavailableFor(input);
    if (reason !== undefined) {
      if (this.fallbackToJs) return RegExp.prototype.exec.call(this, input) !== null;
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
    const reason = this.re2UnavailableFor(str);
    if (reason !== undefined) {
      if (this.fallbackToJs) return RegExp.prototype.exec.call(this, str);
      this.onUnknown?.(reason);
      // unknown: report a match, so nothing is reported as invalid. A global or sticky regex reports one,
      // then no more, so a loop over the matches ends
      if (this.global || this.sticky) {
        if (this.lastIndex !== 0) {
          this.lastIndex = 0;
          return null;
        }
        this.lastIndex = Math.max(str.length, 1);
      }
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
 * The regex a schema value describes, as a SchemaRegExp: a RegExp (from `regex()`), a `/pattern/flags`
 * string, or a plain pattern string (the reading `string(matches=...)` gives a string). Throws the JS
 * syntax error for a pattern that is not valid.
 */
export function toSchemaRegExp(value: RegExp | string, opts: Omit<SchemaRegExpOpts, 'display'>): SchemaRegExp {
  if (value instanceof SchemaRegExp) return value;
  if (value instanceof RegExp) return new SchemaRegExp(value.source, value.flags, opts);
  const literal = value.match(REGEX_LIKE_STRING);
  if (literal) {
    try {
      return new SchemaRegExp(literal[1], literal[2], { ...opts, display: value });
    } catch {
      // not a valid regex literal: the whole string is then read as a pattern
    }
  }
  return new SchemaRegExp(value, undefined, { ...opts, display: value });
}

/**
 * The warning for a schema regex RE2 does not support, or undefined. Default mode still runs it, on the
 * JS engine, for now; shape mode does not run it, so whether a value matches it is unknown.
 */
export function unsupportedRegexWarning(regex: RegExp, context?: string): SchemaError | undefined {
  if (!(regex instanceof SchemaRegExp) || !regex.unsupported) return undefined;
  const prefix = `${context ? `${context} - ` : ''}regex ${regex} uses ${regex.unsupported}, which the linear-time regex engine does not support`;
  if (regex.fallbackToJs) {
    return new SchemaError(`${prefix}. It runs on the JavaScript regex engine for now, but this fallback will be removed in a future version`, {
      isWarning: true,
      tip: 'rewrite the pattern without lookahead, lookbehind or backreferences, so it runs on the linear-time engine',
    });
  }
  return new SchemaError(`${prefix}, so shape mode does not run it and whether the value matches is unknown`, { isWarning: true });
}
