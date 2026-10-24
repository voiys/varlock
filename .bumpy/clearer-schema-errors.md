---
"varlock": patch
---

Clearer errors for common schema mistakes: unknown `@import` options (such as `required=false`) are reported with a pointer to `allowMissing=true` instead of a "path does not exist" error, unknown decorators suggest the closest known one and explain how to keep `@word` as plain text, a comment line starting with `@` that fails to parse says it was read as a decorator, and a plugin version mismatch shows where the installed copy was found and how to fix the pin
