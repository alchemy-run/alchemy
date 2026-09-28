/**
 * The generated entry module for Rivet **runner** bundles: a thin shim
 * importing only the real bootstrap module
 * `alchemy/Runtime/Bootstrap/RivetRunner` (resolvable from any consumer —
 * `alchemy` is its direct dependency) plus the user's `main`. Everything
 * the runner needs lives in that real module, so the generated entry never
 * imports alchemy's own dependencies, which an isolated install cannot
 * resolve from the consumer's project (see `Runtime/Bootstrap/Process.ts`).
 *
 * @internal not exported from the Rivet barrel.
 */
import { isDurableObjectExport } from "../Workers/DurableObject.ts";
import { isSqlMigrationsExport } from "../Workers/SqlMigrationsRuntime.ts";

export const makeRivetRunnerEntry = (
  exports: Record<string, unknown>,
  stack: { name: string; stage: string },
) => {
  const classes = Object.keys(exports ?? {})
    .filter((className) => isDurableObjectExport(exports[className]))
    .map((className) => ({ className }));

  const snapshots = Object.fromEntries(
    Object.entries(exports ?? {}).flatMap(([name, value]) =>
      isSqlMigrationsExport(value) ? [[name, value.snapshot]] : [],
    ),
  );

  return (importPath: string) => `
import { bootstrap } from "alchemy/Runtime/Bootstrap/RivetRunner";
import { withSqlMigrations } from "alchemy/Rivet/SqlMigrationsRuntime";
import userEntrypoint from ${JSON.stringify(importPath)};
const entrypoint = withSqlMigrations(userEntrypoint, ${JSON.stringify(snapshots)});

await bootstrap(entrypoint, {
  stack: {
    name: ${JSON.stringify(stack.name)},
    stage: ${JSON.stringify(stack.stage)},
  },
  classes: ${JSON.stringify(classes)},
});
`;
};
