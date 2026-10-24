/**
 * Finds env keys in source code by structure rather than by regex, for the `calls=` and
 * `props=` forms of `@auditExtraPatterns()`:
 * - `calls=[requireEnv]` finds `requireEnv("KEY")`: a string-literal argument of a call
 * - `props=[credentialName]` finds `credentialName: "KEY"` and `credentialName = "KEY"`
 *
 * A small hand-written lexer splits the file into identifiers, string literals and
 * punctuation, skipping comments, so a name mentioned inside a string or a comment is not a
 * call. It runs in one linear pass and uses no regexes.
 *
 * A lexer can fall out of step with the real language (the built-in scanner deliberately
 * avoids one for that reason). To keep the damage local, quoted strings and JS regex literals
 * end at a newline, so a stray quote costs at most the rest of its line. Only template
 * literals, triple-quoted strings and block comments span lines.
 */

/** languages the scanner knows, `undefined` for a file brought in only by `fileTypes=` */
export type SourceLanguage = 'js-like' | 'python' | 'go' | 'ruby' | 'php' | 'rust' | 'java' | 'csharp';

type Token = | { kind: 'ident', value: string, start: number }
  // `plain` = a complete literal with no interpolation, so `value` is its exact text
  | { kind: 'string', value: string, start: number, plain: boolean }
  | { kind: 'punct', value: string, start: number }
  | { kind: 'other', start: number };

export type ExtractedKey = { key: string, index: number };

const isAsciiLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isDigit = (c: number) => c >= 48 && c <= 57;
const isIdentStart = (c: number) => isAsciiLetter(c) || c === 95 /* _ */ || c === 36 /* $ */ || c >= 128;
const isIdentPart = (c: number) => isIdentStart(c) || isDigit(c);
const isWhitespace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12
  || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029;
// grouped into one token so `=` is never confused with `==`, `=>`, `<=`, ...
const OPERATOR_CHARS = '=<>!&|?:+-*%^~@';

// after one of these keywords a `/` starts a regex literal, not a division
const KEYWORDS_BEFORE_EXPRESSION = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/** identifier-shaped: letters, digits and `_`, not starting with a digit */
export function isEnvKeyName(str: string) {
  if (!str.length || isDigit(str.charCodeAt(0))) return false;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (!isAsciiLetter(c) && !isDigit(c) && c !== 95) return false;
  }
  return true;
}

function commentSyntax(language: SourceLanguage | undefined) {
  if (language === 'python' || language === 'ruby' || language === undefined) {
    return { slash: false, hash: true };
  }
  return { slash: true, hash: language === 'php' };
}

export function tokenizeSource(content: string, language?: SourceLanguage): Array<Token> {
  const tokens: Array<Token> = [];
  const comments = commentSyntax(language);
  const isJs = language === 'js-like';
  const tripleQuotes = language === 'python' || language === undefined;
  const len = content.length;

  /** does a `/` at this point start a regex literal (JS only)? */
  const slashStartsRegex = () => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.kind === 'string' || prev.kind === 'other') return false;
    if (prev.kind === 'ident') return KEYWORDS_BEFORE_EXPRESSION.has(prev.value);
    return prev.value !== ')' && prev.value !== ']' && prev.value !== '}';
  };

  /** a `'` / `"` string (or a non-JS backtick string) ending at its quote or the end of the line */
  const readLineString = (pos: number, quote: number): number => {
    let value = '';
    let i = pos + 1;
    while (i < len) {
      const c = content.charCodeAt(i);
      if (c === quote) {
        tokens.push({
          kind: 'string', value, start: pos, plain: true,
        });
        return i + 1;
      }
      if (c === 10) break; // unterminated: stop at the newline
      if (c === 92 /* \ */ && i + 1 < len && content.charCodeAt(i + 1) !== 10) {
        value += content[i + 1];
        i += 2;
        continue;
      }
      value += content[i];
      i++;
    }
    tokens.push({
      kind: 'string', value, start: pos, plain: false,
    });
    return i;
  };

  /** a string that may span lines, closed by `close` (triple quotes, Go raw strings) */
  const readSpanningString = (pos: number, openLength: number, close: string): number => {
    const end = content.indexOf(close, pos + openLength);
    const stop = end === -1 ? len : end;
    tokens.push({
      kind: 'string', value: content.slice(pos + openLength, stop), start: pos, plain: end !== -1,
    });
    return end === -1 ? len : end + close.length;
  };

  /** JS regex literal; returns the position after it, or -1 if the line ends first */
  const skipRegexLiteral = (pos: number): number => {
    let inClass = false;
    for (let i = pos + 1; i < len; i++) {
      const c = content.charCodeAt(i);
      if (c === 10) return -1;
      if (c === 92) {
        i++;
      } else if (c === 91 /* [ */) {
        inClass = true;
      } else if (c === 93 /* ] */) {
        inClass = false;
      } else if (c === 47 /* / */ && !inClass) {
        let j = i + 1;
        while (j < len && isIdentPart(content.charCodeAt(j))) j++; // flags
        return j;
      }
    }
    return -1;
  };

  const readTemplate = (pos: number): number => {
    const token = {
      kind: 'string' as const, value: '', start: pos, plain: true,
    };
    tokens.push(token);
    let i = pos + 1;
    while (i < len) {
      const c = content.charCodeAt(i);
      if (c === 96 /* ` */) return i + 1;
      if (c === 92) {
        token.value += content[i + 1] ?? '';
        i += 2;
      } else if (c === 36 /* $ */ && content.charCodeAt(i + 1) === 123 /* { */) {
        token.plain = false;
        // lex and readTemplate call each other: a template can hold code that holds a template
        // eslint-disable-next-line no-use-before-define
        i = lex(i + 2, true);
      } else {
        token.value += content[i];
        i++;
      }
    }
    token.plain = false; // unterminated
    return len;
  };

  // re-entered for the expressions inside a template literal's `${...}`
  function lex(start: number, stopAtCloseBrace: boolean): number {
    let i = start;
    let braceDepth = 0;
    while (i < len) {
      const c = content.charCodeAt(i);
      const ch = content[i];
      const next = content.charCodeAt(i + 1);
      if (isWhitespace(c)) {
        i++;
      } else if (comments.slash && c === 47 && next === 47) {
        const nl = content.indexOf('\n', i);
        i = nl === -1 ? len : nl;
      } else if (comments.slash && c === 47 && next === 42 /* * */) {
        const close = content.indexOf('*/', i + 2);
        i = close === -1 ? len : close + 2;
      } else if (comments.hash && c === 35 /* # */) {
        const nl = content.indexOf('\n', i);
        i = nl === -1 ? len : nl;
      } else if (isIdentStart(c)) {
        let j = i + 1;
        while (j < len && isIdentPart(content.charCodeAt(j))) j++;
        tokens.push({ kind: 'ident', value: content.slice(i, j), start: i });
        i = j;
      } else if (isDigit(c)) {
        let j = i + 1;
        while (j < len && (isIdentPart(content.charCodeAt(j)) || content.charCodeAt(j) === 46)) j++;
        tokens.push({ kind: 'other', start: i });
        i = j;
      } else if (c === 34 || c === 39) {
        const triple = ch.repeat(3);
        i = tripleQuotes && content.startsWith(triple, i)
          ? readSpanningString(i, 3, triple)
          : readLineString(i, c);
      } else if (c === 96) {
        if (isJs) i = readTemplate(i);
        else if (language === 'go') i = readSpanningString(i, 1, '`');
        else i = readLineString(i, c);
      } else if (isJs && c === 47 && slashStartsRegex()) {
        const end = skipRegexLiteral(i);
        if (end === -1) {
          tokens.push({ kind: 'punct', value: '/', start: i });
          i++;
        } else {
          tokens.push({ kind: 'other', start: i });
          i = end;
        }
      } else if (OPERATOR_CHARS.includes(ch)) {
        let j = i + 1;
        while (j < len && OPERATOR_CHARS.includes(content[j])) j++;
        tokens.push({ kind: 'punct', value: content.slice(i, j), start: i });
        i = j;
      } else {
        if (stopAtCloseBrace) {
          if (ch === '{') braceDepth++;
          else if (ch === '}') {
            if (braceDepth === 0) return i + 1;
            braceDepth--;
          }
        }
        tokens.push({ kind: 'punct', value: ch, start: i });
        i++;
      }
    }
    return len;
  }

  lex(0, false);
  return tokens;
}

const isPunct = (t: Token | undefined, value: string) => t?.kind === 'punct' && t.value === value;
const isOpen = (t: Token) => t.kind === 'punct' && t.value.length === 1 && '([{'.includes(t.value);
const isClose = (t: Token) => t.kind === 'punct' && t.value.length === 1 && ')]}'.includes(t.value);

// a generic type argument list (`get<string>(...)`) or an argument list is given up on past
// this many tokens, so one unbalanced bracket cannot make the scan quadratic
const MAX_GENERIC_TOKENS = 64;
const MAX_ARGS_TOKENS = 4096;

const isTypeArgPunct = (value: string) => (
  value === ',' || value === '.' || value === '[' || value === ']' || value === '|' || value === '&'
  || [...value].every((ch) => ch === '<' || ch === '>')
);

/** the 0-based index of the `(` opening a call to the name ending at token `i`, or -1 */
function findCallParen(tokens: Array<Token>, i: number): number {
  let j = i + 1;
  if (isPunct(tokens[j], '<')) {
    // skip a generic type argument list: `<string>`, `<Array<string>>`
    let depth = 0;
    for (; j < tokens.length && j - i < MAX_GENERIC_TOKENS; j++) {
      const t = tokens[j];
      if (t.kind === 'ident') continue;
      // only what a type argument list can hold: names, `.`, `,`, `[]`, `|`, `&` and angle
      // brackets. Anything else (`&&`, a string, a number) means this was a comparison
      if (t.kind !== 'punct' || !isTypeArgPunct(t.value)) return -1;
      for (const ch of t.value) {
        if (ch === '<') depth++;
        else if (ch === '>') depth--;
      }
      if (depth <= 0) break;
    }
    if (depth !== 0) return -1;
    j++;
  }
  return isPunct(tokens[j], '(') ? j : -1;
}

/** the tokens of argument `argIndex` (0-based) of the call whose `(` is at `parenIndex` */
function callArgument(tokens: Array<Token>, parenIndex: number, argIndex: number): Array<Token> | undefined {
  let depth = 0;
  let current = 0;
  const arg: Array<Token> = [];
  for (let j = parenIndex + 1; j < tokens.length && j - parenIndex < MAX_ARGS_TOKENS; j++) {
    const t = tokens[j];
    if (depth === 0 && (isPunct(t, ',') || isPunct(t, ')'))) {
      if (current === argIndex) return arg;
      if (isPunct(t, ')')) return undefined;
      current++;
      continue;
    }
    if (isOpen(t)) depth++;
    else if (isClose(t)) {
      if (depth === 0) return undefined; // mismatched bracket
      depth--;
    }
    if (current === argIndex) arg.push(t);
  }
  return undefined;
}

/** an argument or value that is exactly one complete string literal holding an env key name */
function keyFromTokens(arg: Array<Token> | undefined): string | undefined {
  if (arg?.length !== 1) return undefined;
  const [t] = arg;
  if (t.kind !== 'string' || !t.plain || !isEnvKeyName(t.value)) return undefined;
  return t.value;
}

/**
 * Keys passed as a string literal to a call of one of `names`. A name may be dotted
 * (`config.get`), and then must match the end of the callee (`this.config.get(...)`).
 * `argNumber` is 1-based.
 */
export function extractCallKeys(
  tokens: Array<Token>,
  names: Array<string>,
  argNumber = 1,
): Array<ExtractedKey> {
  const byLastPart = new Map<string, Array<Array<string>>>();
  for (const name of names) {
    const parts = name.split('.');
    const last = parts[parts.length - 1];
    if (!byLastPart.has(last)) byLastPart.set(last, []);
    byLastPart.get(last)!.push(parts);
  }

  const found: Array<ExtractedKey> = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'ident') continue;
    const candidates = byLastPart.get(t.value);
    if (!candidates) continue;
    // the rest of a dotted name must precede it: `config . get`
    const matched = candidates.find((parts) => {
      for (let p = parts.length - 2, k = i - 2; p >= 0; p--, k -= 2) {
        const part = tokens[k];
        if (!isPunct(tokens[k + 1], '.') || part?.kind !== 'ident' || part.value !== parts[p]) return false;
      }
      return true;
    });
    if (!matched) continue;
    const paren = findCallParen(tokens, i);
    if (paren === -1) continue;
    const key = keyFromTokens(callArgument(tokens, paren, argNumber - 1));
    // report the position of the callee as written, `config.get(` rather than `get(`
    if (key) found.push({ key, index: tokens[i - 2 * (matched.length - 1)].start });
  }
  return found;
}

/** Keys assigned as a string literal to one of the property `names`: `name: "KEY"`, `name = "KEY"`, `"name": "KEY"` */
export function extractPropKeys(tokens: Array<Token>, names: Array<string>): Array<ExtractedKey> {
  const nameSet = new Set(names);
  const found: Array<ExtractedKey> = [];
  for (let i = 0; i < tokens.length - 2; i++) {
    const t = tokens[i];
    const isName = (t.kind === 'ident' && nameSet.has(t.value))
      || (t.kind === 'string' && t.plain && nameSet.has(t.value));
    if (!isName) continue;
    const op = tokens[i + 1];
    if (!isPunct(op, ':') && !isPunct(op, '=')) continue;
    const key = keyFromTokens([tokens[i + 2]]);
    if (key) found.push({ key, index: t.start });
  }
  return found;
}
