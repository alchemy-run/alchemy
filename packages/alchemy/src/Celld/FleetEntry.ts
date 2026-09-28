/**
 * The generated virtual-entry module for Celld fleet bundles: a thin shim
 * importing only `cloudflare:workers` (runtime-provided), the real
 * bootstrap module `alchemy/Runtime/Bootstrap/CelldFleet` (resolvable from
 * any consumer — `alchemy` is its direct dependency), and the user's
 * `main`. Everything alchemy needs lives in that real module, so the
 * virtual entry never imports alchemy's own dependencies, which an
 * isolated install cannot resolve from the consumer's project (see
 * `Runtime/Bootstrap/Process.ts`).
 *
 * The per-class `export class` statements stay in the shim — celld's
 * loader requires statically named exports.
 *
 * @internal not exported from the Celld barrel.
 */
import { isDurableObjectExport } from "../Workers/DurableObject.ts";
import {
  isSqlMigrationsExport,
  type SqlMigrationSnapshot,
} from "../Workers/SqlMigrationsRuntime.ts";
import { isWorkflowExport } from "./Workflows/Workflow.ts";

export const makeCelldVirtualEntry = (
  exports: Record<string, unknown>,
  stack: { name: string; stage: string },
) => {
  const doClasses = Object.keys(exports).filter((className) =>
    isDurableObjectExport(exports[className]),
  );
  const workflowClasses = Object.keys(exports).filter((className) =>
    isWorkflowExport(exports[className]),
  );
  const migrations: Record<string, SqlMigrationSnapshot> = {};
  for (const [key, entry] of Object.entries(exports)) {
    if (isSqlMigrationsExport(entry)) migrations[key] = entry.snapshot;
  }
  const hasMigrations = Object.keys(migrations).length > 0;
  return (importPath: string) => `
import { DurableObject, WorkerEntrypoint${workflowClasses.length ? ", WorkflowEntrypoint" : ""} } from "cloudflare:workers";
import { makeFleetBootstrap } from "alchemy/Runtime/Bootstrap/CelldFleet";
${hasMigrations ? 'import { withSqlMigrations } from "alchemy/Workers/SqlMigrationsRuntime";' : ""}
import entrypoint from ${JSON.stringify(importPath)};

const fleet = makeFleetBootstrap({ DurableObject, WorkerEntrypoint${workflowClasses.length ? ", WorkflowEntrypoint" : ""} }, ${hasMigrations ? `withSqlMigrations(entrypoint, ${JSON.stringify(migrations)})` : "entrypoint"}, {
  stack: {
    name: ${JSON.stringify(stack.name)},
    stage: ${JSON.stringify(stack.stage)},
  },
});

export default fleet.default;

${doClasses
  .map(
    (className) =>
      `export class ${className} extends fleet.durableObject(${JSON.stringify(className)}) {}`,
  )
  .join("\n")}
${workflowClasses
  .map(
    (className) =>
      `export class ${className} extends fleet.workflow(${JSON.stringify(className)}) {}`,
  )
  .join("\n")}
`;
};
