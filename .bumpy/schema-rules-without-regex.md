---
varlock: minor
---

Add string rules to `string`, `url` and `domain`: `startsWith`/`endsWith` now take a list, plus new `notStartsWith`, `notEndsWith`, `contains`, `notContains` and `chars` (e.g. `chars=hex`, `chars=[digits, "-"]`). Add `glob()` for `remap()` match values, and `calls=[...]`/`props=[...]` for `@auditExtraPatterns()`. Regex patterns in schemas (`matches=`, `regex()`, `/.../` strings) still work but are deprecated and now warn. Key globs in `pick`/`omit` and `@auditIgnoreKeys` no longer slow down on patterns with many `*`.
