---
varlock: minor
---

In shape mode, a plugin that ships a manifest (a `./manifest` export) is read from it and its code never runs. `internal.generatePluginManifest()` builds a manifest from a plugin.
