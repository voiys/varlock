---
varlock: patch
---

Faster loading of large schemas: resolving no longer re-counts every pending item after each one finishes, and the graph's source and dependency lists are computed once after loading instead of on every access
