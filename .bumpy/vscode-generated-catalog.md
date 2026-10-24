---
env-spec-language: patch
---

IntelliSense now covers 21 built-in names that were missing, including `@cache`, `@proxy`, `@dynamic`, `@static`, `@deprecated`, the `duration` type and the `ifs()`, `cache()`, `varlock()`, `keychain()` and `random*()` resolvers. `@dynamic` with `@static`, and repeated `@proxy` value forms, are flagged, and hovering `@proxy` in the header and on an item shows the matching docs. The list is generated from varlock's own registries, so it stays in sync.
