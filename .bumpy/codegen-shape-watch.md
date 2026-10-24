---
varlock: minor
---

Add `varlock codegen --shape` and `varlock codegen --watch`. `--shape` generates without running `exec()`, root decorator commands, secret providers or network requests, which a plain `varlock codegen` does run. `--watch` regenerates when the schema or a file it imports changes, and keeps the last good output while the schema has errors.
