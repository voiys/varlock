---
varlock: minor
---

`varlock codegen` no longer runs `exec()`, root decorator commands or secret providers: it only needs the schema's shape, so it loads in shape mode, and env vars in your shell no longer change its output. Plugin and icon downloads and output paths work as before. Add `varlock codegen --watch`, which regenerates when the schema or a file it imports changes and keeps the last good output while the schema has errors.
