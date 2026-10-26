import * as Artifacts from "alchemy/Artifacts";
import * as Shared from "alchemy/Workers/Workerd/Bundle";
import * as Effect from "effect/Effect";
import { isWorkflowExport } from "../../Workflows/Workflow.ts";
import { isDurableObjectExport } from "../DurableObject.ts";
import type { SourceContext, SourceProvider } from "../Source.ts";
import type { SqlMigrationSnapshot } from "../SqlMigrationsRuntime.ts";
import type { WorkerExport } from "../WorkerRuntimeContext.ts";
import { bundleSource } from "./shared.ts";

export type { WorkerBuildOptions } from "alchemy/Workers/Workerd/Bundle";

export interface WorkerBundleOptions extends Omit<Shared.WorkerBundleOptions, "entry"> {
  entry:
    | {
        kind: "external";
      }
    | {
        kind: "effect";
        exports: Record<string, WorkerExport>;
      };
}

export const WorkerBundle = Shared.makeWorkerBundle<WorkerBundleOptions>({
  // Loaded lazily so importing the Cloudflare provider (or the CLI, whose
  // command tree reaches this module) never loads rolldown's native
  // binding — only actually bundling a Worker does (#562).
  loadCompatPlugins: () =>
    import("@alchemy.run/cloudflare-runtime/rolldown").then((module) => module.default),
  virtualEntry: (options) =>
    options.entry.kind === "effect"
      ? makeEffectVirtualEntry(options.entry.exports, options.stack)
      : undefined,
});

export const makeEffectVirtualEntry = (
  exports: Record<string, WorkerExport>,
  stack: { name: string; stage: string },
) => {
  const doClasses: string[] = [];
  const wfClasses: string[] = [];
  const migrations: Record<string, SqlMigrationSnapshot> = {};
  for (const [className, entry] of Object.entries(exports)) {
    if (isDurableObjectExport(entry)) {
      doClasses.push(className);
    } else if (isWorkflowExport(entry)) {
      wfClasses.push(className);
    } else if (entry.kind === "sqlMigrations") {
      migrations[className] = entry.snapshot;
    }
  }
  const hasMigrations = Object.keys(migrations).length > 0;
  const hasDoClasses = doClasses.length > 0;
  const hasWfClasses = wfClasses.length > 0;
  return (importPath: string) => `
import * as Effect from "effect/Effect";

import { env, DurableObject, WorkerEntrypoint${hasWfClasses ? ", WorkflowEntrypoint" : ""} } from "cloudflare:workers";
import { makeDurableObjectBridge, makeWorkerBridge${hasWfClasses ? ", makeWorkflowBridge" : ""}${hasMigrations ? ", withSqlMigrations" : ""} } from "@alchemy.run/cloudflare/Bridge";
import { makeEntrypointLayer } from "alchemy/Runtime";

import entrypoint from ${JSON.stringify(importPath)};

const meta = {
  entrypoint: ${hasMigrations ? `withSqlMigrations(entrypoint, ${JSON.stringify(migrations)})` : "entrypoint"},
  stack: {
    name: ${JSON.stringify(stack.name)},
    stage: ${JSON.stringify(stack.stage)},
  },
};

export default makeWorkerBridge(WorkerEntrypoint, meta);

// export class proxy stubs for Durable Objects and Workflows
${[
  ...(hasDoClasses
    ? [
        "const DurableObjectBridge = makeDurableObjectBridge(DurableObject, meta);",
        ...doClasses.map((id) => `export class ${id} extends DurableObjectBridge("${id}") {}`),
      ]
    : []),
  ...(hasWfClasses
    ? [
        "const WorkflowBridgeFn = makeWorkflowBridge(WorkflowEntrypoint, meta);",
        ...wfClasses.map((id) => `export class ${id} extends WorkflowBridgeFn("${id}") {}`),
      ]
    : []),
].join("\n")}
`;
};

/**
 * The default source provider: bundle `props.main` with rolldown.
 *
 * `hash()` deliberately builds — recomputing "without building" is
 * impossible for rolldown without a source-tree memo hash, and today's
 * semantics accept that. The build routes through `Artifacts.cached`
 * under the same key as `build()`, so a diff that had to build shares
 * its output with the reconcile in the same run.
 */
export const makeRolldownSource = (options: { main: string }): SourceProvider => {
  const bundleOptions = (ctx: SourceContext): WorkerBundleOptions => ({
    id: ctx.id,
    main: options.main,
    compatibility: ctx.compatibility,
    entry: ctx.entry,
    stack: ctx.stack,
    extraOptions: ctx.extraOptions,
  });
  return bundleSource({
    build: (ctx) =>
      Effect.gen(function* () {
        const bundler = yield* WorkerBundle;
        return yield* bundler.build(bundleOptions(ctx));
      }).pipe(Artifacts.cached("build")),
    watch: (ctx) =>
      Effect.gen(function* () {
        const bundler = yield* WorkerBundle;
        return bundler.watch(bundleOptions(ctx));
      }),
  });
};
