import { internal } from 'varlock';
import type { RegistrySnapshot } from './catalog-generator';

/**
 * Reads the names and descriptions the IntelliSense catalog needs from varlock's built-in registries.
 * A plain `new EnvGraph()` plus the loader's own resolvers (`varlock()`, `keychain()`) is the full set of
 * built-ins and loads nothing, so no schema, plugin, shell command or network access is involved.
 */
export function readVarlockRegistries(): RegistrySnapshot {
  const graph = new internal.EnvGraph();
  internal.registerLoaderResolvers(graph);

  const dataTypes: RegistrySnapshot['dataTypes'] = {};
  for (const [name, factory] of Object.entries(graph.dataTypesRegistry)) {
    let description: string | undefined;
    try {
      description = factory()._rawDef.typeDescription;
    } catch {
      // some data types need arguments to be instantiated; the name is enough
    }
    dataTypes[name] = { description };
  }

  const resolvers: RegistrySnapshot['resolvers'] = {};
  for (const [name, resolverClass] of Object.entries(graph.registeredResolverFunctions)) {
    // internal resolvers (\0static, \0fnArgs, ...) are not something a user can write
    if (name.startsWith('\0')) continue;
    resolvers[name] = { description: resolverClass.def.description };
  }

  return {
    rootDecorators: graph.rootDecoratorsRegistry,
    itemDecorators: graph.itemDecoratorsRegistry,
    dataTypes,
    resolvers,
  };
}
