import { describe, test } from 'vitest';
import outdent from 'outdent';
import { envFilesTest } from './helpers/generic-test';

// The graph memoizes item definitions and the dependency list once loading is complete. @setValuesBulk adds
// definitions and replaces resolvers while root decorators execute, near the end of finishLoad, so these
// cover that the memoized lists see its changes.
describe('memoized graph structure stays in sync with @setValuesBulk', () => {
  test('a bulk value overrides an item defined only in an imported file', envFilesTest({
    files: {
      '.env.schema': outdent`
        # @import(./.env.shared)
        # @setValuesBulk('{"TARGET":"bulk-value"}', format=json)
        # ---
        OTHER=1
      `,
      '.env.shared': outdent`
        TARGET=original-value
      `,
    },
    expectValues: {
      TARGET: 'bulk-value',
      OTHER: 1,
    },
  }));

  test('a bulk value replacing a reference drops the old dependency', envFilesTest({
    envFile: outdent`
      # @setValuesBulk('{"TARGET":"bulk-value"}', format=json)
      # ---
      # @required
      BAD=
      TARGET=$BAD
    `,
    expectValues: {
      TARGET: 'bulk-value',
    },
  }));

  test('a bulk value still wins over the schema value for an item defined in the root file', envFilesTest({
    envFile: outdent`
      # @setValuesBulk('{"API_KEY":"from-bulk"}', format=json)
      # ---
      API_KEY=from-schema
    `,
    expectValues: {
      API_KEY: 'from-bulk',
    },
  }));
});
