export type GlobMatcher = { test: (str: string) => boolean };

// what `.` matched when globs compiled to regexes: any character but a line terminator
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/**
 * Compile a simple glob pattern into an anchored matcher. Supports `*` (any run of
 * characters) and `?` (single character); every other character matches literally.
 * Used by key filters (`@setValuesBulk` and `@import` pick/omit), `@auditIgnoreKeys`
 * and `glob()` match values in `remap()`.
 * Matching is case-sensitive, since env keys are case-sensitive.
 *
 * Matching is O(pattern * key). A regex like `^.*A.*A.*A...B$` (what this used to compile to)
 * backtracks polynomially in the number of stars: 8 stars against a 60-character key took about a minute.
 */
export function compileGlob(pattern: string): GlobMatcher {
  return {
    test(str: string) {
      if (LINE_TERMINATOR.test(str)) return false;
      // greedy wildcard matching, backtracking only to the most recent star
      let p = 0;
      let s = 0;
      let starP = -1;
      let starS = 0;
      while (s < str.length) {
        if (pattern[p] === '*') {
          starP = p++;
          starS = s;
        } else if (p < pattern.length && (pattern[p] === '?' || pattern[p] === str[s])) {
          p++;
          s++;
        } else if (starP !== -1) {
          p = starP + 1;
          s = ++starS;
        } else {
          return false;
        }
      }
      while (pattern[p] === '*') p++;
      return p === pattern.length;
    },
  };
}

/**
 * The value of a `glob("pattern")` call: a match value for `remap()`. Like `regex()` it only
 * makes sense as a function arg, never as an item's final value.
 */
export class GlobPattern implements GlobMatcher {
  private matcher: GlobMatcher;
  constructor(readonly pattern: string) {
    this.matcher = compileGlob(pattern);
  }
  test(str: string) { return this.matcher.test(str); }
  toString() { return `glob(${JSON.stringify(this.pattern)})`; }
}
