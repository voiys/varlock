// Regex patterns in schemas are deprecated: `matches=` on a data type, `regex()` and `/.../`
// strings as `remap()` match values, and regex patterns in `@auditExtraPatterns()`. They all
// keep working, but each use gets a warning that names the regex-free replacement.
//
// User-written regexes are hard to get right, can backtrack catastrophically on a crafted
// value, and hide what they check. The replacements (string rules, `glob()`, audit
// `calls=`/`props=`) are plain string operations.
import { SchemaError } from './errors';
import { REGEX_LIKE_STRING } from './regex-like-string';

export const STRING_RULES_LIST = 'startsWith, endsWith, notStartsWith, notEndsWith, contains, notContains, chars, minLength, maxLength, isLength';
const STILL_WORKS = 'regex patterns still work for now, but a future major version will remove them';

/** a pattern split into its source and flags, from a RegExp, a `/.../flags` string, or a plain source string */
export type PatternParts = { source: string, flags: string };
export function patternParts(pattern: RegExp | string): PatternParts {
  if (pattern instanceof RegExp) return { source: pattern.source, flags: pattern.flags };
  const literal = pattern.match(REGEX_LIKE_STRING);
  if (literal) return { source: literal[1], flags: literal[2] };
  return { source: pattern, flags: '' };
}

type Segment = { kind: 'text', text: string } | { kind: 'any' } | { kind: 'one' };
type LiteralShape = { anchoredStart: boolean, anchoredEnd: boolean, segments: Array<Segment> };

// characters that are literal when escaped with a backslash
const ESCAPABLE = '.^$*+?()[]{}|\\/-';
const SPECIAL = '.^$*+?()[]{}|\\';

/**
 * Read a regex made only of literal text, `.*`, `.+`, `.` and `^`/`$` anchors (and
 * single-character classes like `[.]`). Returns undefined for anything else, which is
 * just "no suggestion" for the callers below.
 */
function readLiteralShape({ source, flags }: PatternParts): LiteralShape | undefined {
  if (flags.replace('g', '') !== '') return undefined;
  let src = source;
  const anchoredStart = src.startsWith('^');
  if (anchoredStart) src = src.slice(1);
  let anchoredEnd = false;
  if (src.endsWith('$')) {
    // a `$` escaped by an odd number of backslashes is a literal dollar sign
    let backslashes = 0;
    for (let i = src.length - 2; i >= 0 && src[i] === '\\'; i--) backslashes++;
    if (backslashes % 2 === 0) {
      anchoredEnd = true;
      src = src.slice(0, -1);
    }
  }
  const segments: Array<Segment> = [];
  const pushText = (ch: string) => {
    const last = segments[segments.length - 1];
    if (last?.kind === 'text') last.text += ch;
    else segments.push({ kind: 'text', text: ch });
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') {
      const next = src[i + 1];
      if (next === undefined || !ESCAPABLE.includes(next)) return undefined;
      pushText(next);
      i++;
    } else if (ch === '[') {
      // `[.]` style: one character in a class
      const inner = src[i + 1];
      if (inner === undefined || src[i + 2] !== ']' || inner === '^' || inner === '\\' || inner === ']') return undefined;
      pushText(inner);
      i += 2;
    } else if (ch === '.') {
      const next = src[i + 1];
      if (next === '*') {
        segments.push({ kind: 'any' });
        i++;
      } else if (next === '+') {
        segments.push({ kind: 'one' }, { kind: 'any' });
        i++;
      } else {
        segments.push({ kind: 'one' });
      }
    } else if (SPECIAL.includes(ch)) {
      return undefined;
    } else {
      pushText(ch);
    }
  }
  return { anchoredStart, anchoredEnd, segments };
}

/** the `glob()` call matching the same values as a simple regex, if there is one */
export function suggestGlobForRegex(parts: PatternParts): string | undefined {
  const shape = readLiteralShape(parts);
  if (!shape) return undefined;
  let glob = shape.anchoredStart ? '' : '*';
  for (const segment of shape.segments) {
    if (segment.kind === 'text') {
      // a glob has no escape for a literal * or ?
      if (segment.text.includes('*') || segment.text.includes('?')) return undefined;
      glob += segment.text;
    } else {
      glob += segment.kind === 'any' ? '*' : '?';
    }
  }
  if (!shape.anchoredEnd) glob += '*';
  while (glob.includes('**')) glob = glob.replace('**', '*');
  return `glob(${JSON.stringify(glob)})`;
}

/** the string rules matching the same values as a simple regex, if there are any */
export function suggestStringRulesForRegex(parts: PatternParts): string | undefined {
  const shape = readLiteralShape(parts);
  if (!shape) return undefined;
  const segments = shape.segments.filter((s, i, all) => !(s.kind === 'any' && (i === 0 || i === all.length - 1)));
  const startsFree = !shape.anchoredStart || shape.segments[0]?.kind === 'any';
  const endsFree = !shape.anchoredEnd || shape.segments[shape.segments.length - 1]?.kind === 'any';
  if (segments.length !== 1 || segments[0].kind !== 'text') return undefined;
  const text = JSON.stringify(segments[0].text);
  if (!startsFree && !endsFree) return undefined; // an exact value, which is not a pattern at all
  if (!startsFree) return `startsWith=${text}`;
  if (!endsFree) return `endsWith=${text}`;
  return `contains=${text}`;
}

/** `matches=` on a built-in type, in any form */
export function matchesDeprecationWarning(context: string, pattern?: RegExp | string, extraTip?: string) {
  const suggestion = pattern !== undefined ? suggestStringRulesForRegex(patternParts(pattern)) : undefined;
  return new SchemaError(`${context} - regex patterns are deprecated, use string rules instead`, {
    isWarning: true,
    tip: [
      ...suggestion ? [`write it as ${suggestion}`] : [],
      ...extraTip ? [extraTip] : [],
      `string rules: ${STRING_RULES_LIST}`,
      STILL_WORKS,
    ],
  });
}

/** `regex()` calls and `/.../` strings used as `remap()` match values */
export function remapRegexDeprecationWarning(patterns: Array<{ label: string, parts: PatternParts }>) {
  const rewrites: Array<string> = [];
  for (const { label, parts } of patterns) {
    const glob = suggestGlobForRegex(parts);
    const line = glob ? `write ${label} as ${glob}` : undefined;
    if (line && !rewrites.includes(line)) rewrites.push(line);
  }
  return new SchemaError('regex match values are deprecated, use glob() or an exact value instead', {
    isWarning: true,
    tip: [
      ...rewrites,
      'glob("pattern") matches the whole value: * matches any run of characters, ? a single character',
      STILL_WORKS,
    ],
  });
}

/** regex patterns passed to `@auditExtraPatterns()` */
export function auditRegexDeprecationWarning() {
  return new SchemaError('@auditExtraPatterns(): regex patterns are deprecated, use calls=[...] or props=[...] instead', {
    isWarning: true,
    tip: [
      'calls=[fnName] finds the key passed as a string to a call like fnName("KEY") (arg=N picks another argument)',
      'props=[name] finds the key assigned to a property, like name: "KEY" or name = "KEY"',
      STILL_WORKS,
    ],
  });
}
