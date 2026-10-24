import { describe, test, expect } from 'vitest';
import { compileGlob } from '../lib/glob';

describe('key globs', () => {
  test.each([
    ['API_*', 'API_KEY', true],
    ['API_*', 'XAPI_KEY', false],
    ['*_URL', 'DB_URL', true],
    ['A?C', 'ABC', true],
    ['A?C', 'AC', false],
    ['*', '', true],
    ['A*B*C', 'AXXBYYC', true],
    ['A*B*C', 'AXXBYY', false],
    ['A.B', 'AXB', false], // regex specials are literal
    ['*', 'A*B', true],
    ['A\\*', 'A\\BC', true],
  ])('%s matches %s: %s', (pattern, key, expected) => {
    expect(compileGlob(pattern).test(key)).toBe(expected);
  });

  test('many stars against a long key finish in linear time', () => {
    // compiled to a backtracking regex (`^.*A.*A...B$`) this blocks the thread: about 2 s for 7 stars and a
    // 50-character key, about a minute for 8 stars and 60 characters
    const pattern = `${'*A'.repeat(7)}*B`;
    const t0 = performance.now();
    expect(compileGlob(pattern).test('A'.repeat(50))).toBe(false);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
