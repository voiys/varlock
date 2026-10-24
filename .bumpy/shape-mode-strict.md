---
varlock: minor
---

Shape mode takes `runPluginCode: false`, which never runs plugin code: a plugin without a manifest is not loaded, and what it would register is unknown. Schema regexes (`regex()`, `matches`, `remap()` patterns, `@auditExtraPatterns()`) now run on a linear-time engine (RE2JS) in every mode, so a pattern with catastrophic backtracking can no longer stall loading. A pattern using lookahead, lookbehind or backreferences gets a warning: it still runs on the JavaScript engine for now (this fallback will be removed), and shape mode treats its match as unknown. Key globs in `pick`, `omit` and `@auditIgnoreKeys` now match in linear time.
