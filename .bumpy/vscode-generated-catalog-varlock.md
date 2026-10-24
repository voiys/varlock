---
varlock: patch
---

Internal: `varlock()` and `keychain()` are registered through a shared `registerLoaderResolvers()` helper, exposed on `internal` so editor tooling can list every built-in resolver. No change to loading behavior.
