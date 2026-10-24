import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'env-spec-language',
  },
  resolve: {
    // the catalog tests read varlock's registries; resolve `varlock` from source so they do not
    // depend on the sibling package having been built first
    conditions: ['ts-src'],
  },
  ssr: {
    // vitest resolves dependencies through the ssr pipeline, which does not inherit resolve.conditions
    resolve: {
      conditions: ['ts-src'],
    },
  },
  define: {
    // injected by varlock's own build; 'release' matches a published build (no test-only decorators)
    __VARLOCK_BUILD_TYPE__: JSON.stringify('release'),
    __VARLOCK_SEA_BUILD__: 'false',
  },
});
