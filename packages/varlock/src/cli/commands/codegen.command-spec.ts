import { define } from 'gunshi';

export const commandSpec = define({
  name: 'codegen',
  description: 'Generate code (types and env modules) from your env schema',
  args: {
    path: {
      type: 'string',
      short: 'p',
      multiple: true,
      description: 'Path to a specific .env file or directory to use as the entry point (can be specified multiple times)',
    },
    shape: {
      type: 'boolean',
      description: 'Load the schema without running exec(), secret providers, root decorators, plugin downloads or network requests, and ignore process.env',
    },
    watch: {
      type: 'boolean',
      description: 'Regenerate whenever the schema or a file it imports changes (implies --shape)',
    },
  },
  examples: `
Generates code from your .env schema files.
Uses only non-environment-specific schema info, so output is deterministic
regardless of which environment is active.

Add a per-language decorator to your schema for each output you want:
  @generateTsTypes(path=env.d.ts)
  @generatePythonEnv(path=env.py)
  @generateRustEnv(path=src/env.rs)
  @generateGoEnv(path=env/env.go)
  @generatePhpEnv(path=Env.php)

This is useful when you have \`auto=false\` set on a generator decorator to
disable automatic generation during \`varlock load\` or \`varlock run\`.

By default the schema is loaded like \`varlock load\` does, so shell commands in
root decorators (for example @cache=exec(...) or @setValuesBulk(exec(...))) run.
Pass --shape to load it without running anything, which also makes the output
independent of the env vars set in your shell. --watch implies --shape and keeps
the last good output while the schema has errors.

Examples:
  varlock codegen                    # Generate using the default schema
  varlock codegen --path .env.prod   # Generate from a specific .env file
  varlock codegen --shape         # Generate without running exec() or other resolvers
  varlock codegen --watch            # Regenerate on every change to the schema
`.trim(),
});
