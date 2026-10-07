/// <reference types="@cloudflare/workers-types" />

import type { WorkerCache } from "./Worker.ts";
import type { WorkerExport } from "./WorkerRuntimeContext.ts";

type ClassOf<Instance> = abstract new (...args: any[]) => Instance;

/**
 * Settings for a Durable Object class the Worker module exports.
 */
export interface DurableObjectExportProps {
  /**
   * Storage backend of the class's namespace. New namespaces are always
   * SQLite-backed. An existing namespace keeps the backend it was created
   * with, which Alchemy reads from Cloudflare, so set this only to assert
   * it.
   * @default the observed backend, or "sqlite" for a new namespace
   */
  storage?: "sqlite" | "legacy-kv";
}

/**
 * Settings for a named `WorkerEntrypoint` class the Worker module exports.
 */
export interface EntrypointExportProps {
  /**
   * Workers Cache settings for this entrypoint. Overrides the Worker-wide
   * `cache` prop for requests routed to this entrypoint.
   * @default the Worker-wide `cache` setting
   */
  cache?: WorkerCache;
}

/**
 * Retires a Durable Object class the module no longer exports, deleting its
 * namespace and **all stored data permanently**. Only needed for a class
 * Alchemy did not create (for example one adopted from a Wrangler deploy):
 * Alchemy deletes classes it created when they leave the declaration.
 */
export interface DeletedDurableObjectExport {
  state: "deleted";
}

/**
 * The settings accepted for one export, chosen by the export's class:
 * Durable Object classes take {@link DurableObjectExportProps},
 * `WorkerEntrypoint` classes take {@link EntrypointExportProps}, and
 * anything else is rejected.
 */
export type ExportProps<Value> =
  Value extends ClassOf<Rpc.DurableObjectBranded>
    ? DurableObjectExportProps
    : Value extends ClassOf<Rpc.WorkerEntrypointBranded>
      ? EntrypointExportProps
      : never;

/**
 * Names of the `WorkerEntrypoint` classes a module exports.
 */
export type EntrypointExportName<Module> = {
  [K in keyof Module]: Module[K] extends ClassOf<Rpc.WorkerEntrypointBranded> ? K : never;
}[keyof Module] &
  string;

/**
 * Names of the Durable Object classes a module exports.
 */
export type DurableObjectExportName<Module> = {
  [K in keyof Module]: Module[K] extends ClassOf<Rpc.DurableObjectBranded> ? K : never;
}[keyof Module] &
  string;

/**
 * A Worker's declared exports, created by {@link Exports}.
 */
export interface WorkerExports {
  readonly "~alchemy/Kind": "Cloudflare.Workers.Exports";
  readonly entries: {
    readonly [name: string]:
      | DurableObjectExportProps
      | EntrypointExportProps
      | DeletedDurableObjectExport;
  };
}

/** Returns true when the value was created by {@link Exports}. */
export const isWorkerExports = (value: unknown): value is WorkerExports =>
  typeof value === "object" &&
  value !== null &&
  "~alchemy/Kind" in value &&
  (value as WorkerExports)["~alchemy/Kind"] === "Cloudflare.Workers.Exports";

/**
 * Declares the Durable Object and `WorkerEntrypoint` classes an async
 * Worker's module exports, type-checked against the module itself.
 *
 * Pass the module's type with `typeof import(...)`. It is a type-only
 * import, so nothing from the Worker module is loaded at deploy time and
 * no code generation is needed. Each key must name a class the module
 * exports, and its settings depend on the class: a Durable Object takes
 * `storage`, a `WorkerEntrypoint` takes `cache`. A key the module does
 * not export may only be a `deleted` tombstone.
 *
 * Declare `WorkerEnv` as an interface (`interface WorkerEnv extends
 * Cloudflare.InferEnv<typeof Worker> {}`). A type alias makes TypeScript
 * resolve the module's classes (which extend `DurableObject<WorkerEnv>`)
 * while it is still computing the Worker's type, and reports a circular
 * reference.
 *
 * ```typescript
 * type Main = typeof import("./src/worker.ts");
 *
 * export const Worker = Cloudflare.Worker("Api", {
 *   main: "./src/worker.ts",
 *   exports: Cloudflare.Exports<Main>()({
 *     Counter: {},
 *     CachedRead: { cache: { enabled: true } },
 *   }),
 * });
 *
 * export interface WorkerEnv extends Cloudflare.InferEnv<typeof Worker> {}
 * ```
 */
export const Exports =
  <Module>() =>
  <const Entries extends object>(entries: {
    [K in keyof Entries]: K extends keyof Module
      ? ExportProps<Module[K]>
      : DeletedDurableObjectExport;
  }): WorkerExports => ({
    "~alchemy/Kind": "Cloudflare.Workers.Exports",
    entries: entries as WorkerExports["entries"],
  });

/**
 * The `GlobalProps` that `@cloudflare/workers-types` reads to type
 * `ctx.exports` and the `exports` import from `cloudflare:workers`. This is
 * what `wrangler types` generates; extend it instead:
 *
 * ```typescript
 * import type { InferGlobalProps } from "alchemy/Cloudflare";
 *
 * declare global {
 *   namespace Cloudflare {
 *     interface GlobalProps extends InferGlobalProps<typeof import("./src/worker.ts")> {}
 *   }
 * }
 * ```
 */
export type InferGlobalProps<Module> = {
  mainModule: Module;
  durableNamespaces: DurableObjectExportName<Module>;
};

/**
 * The exports an Effect-native Worker collected at runtime (Durable Object,
 * Workflow and SQL-migration entries). Empty for an async Worker, whose
 * `exports` prop holds the user's {@link WorkerExports} declaration.
 * @internal
 */
export const getEffectExports = (
  exports: WorkerExports | Record<string, WorkerExport> | undefined,
): Record<string, WorkerExport> =>
  exports === undefined || isWorkerExports(exports) ? {} : exports;
