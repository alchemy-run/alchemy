import * as Effect from "effect/Effect";
import { ConfigError } from "./RuntimeError.shared.ts";
import type { DurableObjectNamespace } from "./RuntimeWorker.ts";
import type { Worker_Module } from "./workerd/Config.ts";

/**
 * Add Miniflare's local SQL/name RPC methods to the exported DO classes.
 * All bindings, namespace keys and storage services still point at the
 * original worker. Re-exporting its other exports preserves named entrypoints.
 */
export const wrapDurableObjectModules = Effect.fn(
  "LocalExplorer.wrapDurableObjects",
)(function* (
  modules: Worker_Module[],
  namespaces: ReadonlyArray<DurableObjectNamespace>,
  wrapper: string,
) {
  const classes = [
    ...new Set(
      namespaces
        .filter((ns) => ns.sql && !ns.ephemeralLocal)
        .map((ns) => ns.className),
    ),
  ];
  if (!classes.length) return modules;
  if (!modules[0] || !("esModule" in modules[0])) {
    return yield* new ConfigError({
      subtag: "LocalExplorer",
      message: "Durable Object inspection requires an ES module entrypoint.",
    });
  }
  const entryName = "__alchemy_explorer_entry.js";
  const wrapperName = "__alchemy_explorer_do.js";
  if (
    modules.some(
      (module) => module.name === entryName || module.name === wrapperName,
    )
  ) {
    return yield* new ConfigError({
      subtag: "LocalExplorer",
      message: "Worker modules use a reserved Local Explorer module name.",
    });
  }
  const original = JSON.stringify(`./${modules[0].name}`);
  const source = [
    `import { createDurableObjectWrapper } from "./${wrapperName}";`,
    `import * as original from ${original};`,
    `export * from ${original};`,
    ...(classes.includes("default")
      ? []
      : ["export default original.default;"]),
    ...classes.map(
      (name, index) =>
        `const DO_${index} = createDurableObjectWrapper(original[${JSON.stringify(name)}]);\nexport { DO_${index} as ${JSON.stringify(name)} };`,
    ),
  ].join("\n");
  return [
    { name: entryName, esModule: source },
    { name: wrapperName, esModule: wrapper },
    ...modules,
  ] satisfies Worker_Module[];
});
