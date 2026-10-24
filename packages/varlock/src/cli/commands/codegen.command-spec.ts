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
      description: 'Load the schema in shape mode: skip exec() and other resolvers with side effects, root decorator commands, secret providers, plugin downloads and network requests',
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
--shape loads it in shape mode instead: exec() and other resolvers with side
effects, root decorator commands, secret providers, plugin downloads and network
requests (such as custom icon downloads) are skipped, and env vars set in your shell
no longer override item values. Plugins that are already installed are still
loaded and their code runs. --watch implies --shape, and while the schema has
errors it leaves the generated files as they were.

Examples:
  varlock codegen                    # Generate using the default schema
  varlock codegen --path .env.prod   # Generate from a specific .env file
  varlock codegen --shape         # Generate without running exec() or other resolvers
  varlock codegen --watch            # Regenerate on every change to the schema
`.trim(),
});
