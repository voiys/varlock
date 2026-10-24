/**
 * Generates src/intellisense-catalog.ts from varlock's own registries, so the extension cannot drift
 * from the decorators, data types and resolvers varlock actually supports.
 *
 *   bun run generate:catalog   rewrite src/intellisense-catalog.ts
 *   bun run check:catalog      exit 1 if the committed file is stale or the prose overlay has dead entries
 *
 * It imports the built `varlock` package, so build it first (`bunx turbo run build --filter=varlock`).
 * See catalog-generator.ts for how the registries and the prose overlay are merged.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as overlay from '../src/intellisense-prose';
import { buildCatalog, checkCatalog } from './catalog-generator';
import { readVarlockRegistries } from './registry-snapshot';

const OUT = path.resolve(import.meta.dirname, '../src/intellisense-catalog.ts');
const registries = readVarlockRegistries();

if (process.argv.includes('--check')) {
  const committed = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : undefined;
  const result = checkCatalog(registries, overlay, committed);
  if (result.ok) {
    console.log('intellisense-catalog.ts is up to date');
  } else {
    for (const problem of result.problems) console.error(problem);
  }
  process.exit(result.ok ? 0 : 1);
}

const { source, report } = buildCatalog(registries, overlay);
fs.writeFileSync(OUT, source);
console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
if (report.fromRegistryOnly.length) {
  console.log(`no entry in src/intellisense-prose.ts for: ${report.fromRegistryOnly.join(', ')}`);
}
if (report.genericNames.length) {
  console.log(`no description anywhere (generic summary used): ${report.genericNames.join(', ')}`);
}
if (report.isFunctionConflicts.length) {
  console.log(`isFunction in src/intellisense-prose.ts disagrees with varlock for: ${report.isFunctionConflicts.join(', ')}`);
}
if (report.orphanedOverlay.length) {
  console.log(`dropped, varlock does not register: ${report.orphanedOverlay.join(', ')}`);
}
