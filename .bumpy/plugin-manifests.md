---
varlock: minor
---

In shape mode, a plugin that ships a manifest (a `./manifest` export) is read from it and its code never runs. A data type can describe its `validate()` as `validationRules`, which a manifest carries and shape mode applies, and a manifest can carry proxy transform schemes. `internal.generatePluginManifest()` builds a manifest from a plugin and checks that its validation rules agree with its `validate()`.
