---
varlock: minor
---

Shape mode takes `runPluginCode: false`, which never runs plugin code: a plugin without a manifest is not loaded, and what it would register is unknown. Shape mode now runs schema regexes on a linear-time engine (RE2JS), so a pattern with catastrophic backtracking can no longer stall it. Key globs in `pick`, `omit` and `@auditIgnoreKeys` now match in linear time.
