import * as NodeModule from "node:module";
import { createHooks, type LoaderOptions } from "./hooks.ts";

export type { LoaderHooks, LoaderOptions } from "./hooks.ts";

export interface OxcLoader {
  unregister(): void;
}

const registrationKey = Symbol.for("@alchemy.run/node-utils/register-oxc");

/**
 * Installs the Oxc TypeScript loader process-wide. Alchemy starts every
 * Node process with `--import` of a file that calls this; in-process
 * callers (the dev exec child, tests) may call it again and get the same
 * registration back — a second copy of the hooks would only re-run the
 * chain. The marker lives on `globalThis` because a checkout can load this
 * module twice (src/ and lib/).
 *
 * Reloading one import graph in place is `watchImport` (../watch), which
 * layers a namespace over the same hooks.
 */
export const registerOxc = (options: LoaderOptions = {}): OxcLoader => {
  const registrations = globalThis as typeof globalThis & { [registrationKey]?: OxcLoader };
  const existing = registrations[registrationKey];
  if (existing !== undefined) return existing;

  // Transformed sources reference their source maps (see ./source-map.ts);
  // Node only reads and applies them to stack traces once source-map
  // support is on. `nodeModules` stays on: a published alchemy runs its own
  // `lib/` from `node_modules`, and ships maps back to its `src/`.
  const previousSourceMaps = NodeModule.getSourceMapsSupport();
  NodeModule.setSourceMapsSupport(true, {
    nodeModules: true,
    generatedCode: previousSourceMaps.generatedCode,
  });
  const hooks = NodeModule.registerHooks(createHooks(options));

  const loader: OxcLoader = {
    unregister() {
      hooks.deregister();
      if (registrations[registrationKey] === loader) delete registrations[registrationKey];
      const { enabled, ...options } = previousSourceMaps;
      NodeModule.setSourceMapsSupport(enabled, options);
    },
  };
  registrations[registrationKey] = loader;
  return loader;
};
