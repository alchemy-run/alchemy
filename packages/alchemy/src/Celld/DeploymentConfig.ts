import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { ContainerDeclaration } from "./Containers/Container.ts";

/** Native bindings supported by the Celld v0.5 deployment format. */
export type CelldBinding =
  | { type: "kv_namespace"; name: string; namespaceId: string }
  | { type: "d1"; name: string; id: string; databaseName?: string }
  | { type: "r2_bucket"; name: string; bucketName: string }
  | { type: "queue"; name: string; queueName: string; deliveryDelay?: number }
  | { type: "workflow"; name: string; workflowName: string; className: string }
  | { type: "service"; name: string; service: string; entrypoint?: string }
  | { type: "worker_loader"; name: string };

/** A push consumer attached to the Worker being deployed. */
export interface CelldQueueConsumer {
  /** Fleet-wide queue name. */
  queue: string;
  /** Maximum messages delivered together. */
  maxBatchSize?: number;
  /** Maximum seconds to wait for a batch. */
  maxBatchTimeout?: number;
  /** Retries before dead-letter delivery or removal. */
  maxRetries?: number;
  /** Fleet-wide dead-letter queue name. */
  deadLetterQueue?: string;
  /** Maximum concurrent consumer invocations. */
  maxConcurrency?: number;
  /** Default retry delay in seconds. */
  retryDelay?: number;
}

/** Image/program declaration attached to a same-script SQLite Durable Object. */
export type CelldContainerConfig = ContainerDeclaration;

/** Static asset paths and native routing settings in a staged project. */
export interface CelldAssetsConfig {
  /** Asset directory relative to the Worker's entry module. */
  directory: string;
  /** Environment binding exposed to the Worker. */
  binding?: string;
  /** HTML redirect and trailing-slash behavior. */
  htmlHandling?:
    | "auto-trailing-slash"
    | "force-trailing-slash"
    | "drop-trailing-slash"
    | "none";
  /** Response when an asset is absent. */
  notFoundHandling?: "none" | "404-page" | "single-page-application";
  /** Routes that execute the Worker before checking assets. */
  runWorkerFirst?: boolean | string[];
}

/** A deployment would contain conflicting environment bindings. */
export class CelldBindingConflict extends Data.TaggedError(
  "Celld.BindingConflict",
)<{
  readonly message: string;
}> {}

/** Check names across native bindings, Durable Objects, assets, and variables. */
export const validateBindingNames = (options: {
  bindings: readonly CelldBinding[];
  durableObjects: readonly { name: string }[];
  vars: Record<string, unknown>;
  assets?: CelldAssetsConfig;
}) =>
  Effect.gen(function* () {
    const names = new Set<string>();
    for (const name of [
      ...options.bindings.map((binding) => binding.name),
      ...options.durableObjects.map((binding) => binding.name),
      ...Object.keys(options.vars),
      ...(options.assets?.binding ? [options.assets.binding] : []),
    ]) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(name) || names.has(name)) {
        return yield* Effect.fail(
          new CelldBindingConflict({
            message: `Invalid or duplicate Celld environment binding '${name}'. Bindings must be JavaScript identifiers of at most 128 ASCII characters.`,
          }),
        );
      }
      names.add(name);
    }
  });

/** Lower native binding declarations into Celld's deployment metadata. */
export const deploymentMetadata = (options: {
  scriptName: string;
  mainModule: string;
  compatibilityDate: string;
  compatibilityFlags: readonly string[];
  bindings: readonly CelldBinding[];
  durableObjects: readonly { name: string; className: string }[];
  vars: Record<string, string>;
  queueConsumers: readonly CelldQueueConsumer[];
  assets?: CelldAssetsConfig;
}) =>
  Effect.gen(function* () {
    yield* validateBindingNames(options);
    const classes = new Set(
      options.durableObjects.map((binding) => binding.className),
    );
    const bindings: Record<string, unknown>[] = options.durableObjects.map(
      (binding) => ({
        type: "durable_object_namespace",
        name: binding.name,
        class_name: binding.className,
      }),
    );
    for (const binding of options.bindings) {
      switch (binding.type) {
        case "kv_namespace":
          classes.add("__KvNamespace");
          bindings.push({
            type: "kv",
            name: binding.name,
            id: binding.namespaceId,
          });
          break;
        case "d1":
          classes.add("__D1Database");
          bindings.push({
            type: "d1",
            name: binding.name,
            database_id: binding.id,
            database_name: binding.databaseName ?? binding.id,
          });
          break;
        case "r2_bucket":
          bindings.push({
            type: "r2_bucket",
            name: binding.name,
            bucket_name: binding.bucketName,
          });
          break;
        case "queue":
          classes.add("__Queue");
          bindings.push({
            type: "queue",
            name: binding.name,
            queue: binding.queueName,
            ...(binding.deliveryDelay === undefined
              ? {}
              : { delivery_delay: binding.deliveryDelay }),
          });
          break;
        case "workflow":
          classes.add(`__Workflow.${options.scriptName}`);
          bindings.push({
            type: "workflow",
            name: binding.name,
            workflow_name: binding.workflowName,
            class_name: binding.className,
          });
          break;
        case "service":
          bindings.push({
            type: "service",
            name: binding.name,
            service: binding.service,
            ...(binding.entrypoint === undefined
              ? {}
              : { entrypoint: binding.entrypoint }),
          });
          break;
        case "worker_loader":
          bindings.push({ type: "worker_loader", name: binding.name });
          break;
      }
    }
    for (const [name, text] of Object.entries(options.vars)) {
      bindings.push({ type: "plain_text", name, text });
    }
    if (options.assets?.binding) {
      bindings.push({ type: "assets", name: options.assets.binding });
    }
    const queueConsumers = options.queueConsumers.map((consumer) => ({
      queue: consumer.queue,
      max_batch_size: consumer.maxBatchSize ?? 10,
      max_batch_timeout: consumer.maxBatchTimeout ?? 5,
      max_retries: consumer.maxRetries ?? 3,
      ...(consumer.deadLetterQueue === undefined
        ? {}
        : { dead_letter_queue: consumer.deadLetterQueue }),
      ...(consumer.maxConcurrency === undefined
        ? {}
        : { max_concurrency: consumer.maxConcurrency }),
      ...(consumer.retryDelay === undefined
        ? {}
        : { retry_delay: consumer.retryDelay }),
    }));
    if (queueConsumers.length) classes.add("__Queue");
    const sqliteClasses = [...classes].sort();
    const metadata: Record<string, unknown> = {
      main_module: options.mainModule,
      compatibility_date: options.compatibilityDate,
      compatibility_flags: [...options.compatibilityFlags],
      bindings,
      ...(queueConsumers.length ? { queue_consumers: queueConsumers } : {}),
      ...(sqliteClasses.length
        ? { migrations: { new_sqlite_classes: sqliteClasses } }
        : {}),
      ...(options.assets
        ? {
            assets: {
              ...(options.assets.binding
                ? { binding: options.assets.binding }
                : {}),
              ...(options.assets.htmlHandling
                ? { html_handling: options.assets.htmlHandling }
                : {}),
              ...(options.assets.notFoundHandling
                ? { not_found_handling: options.assets.notFoundHandling }
                : {}),
              ...(options.assets.runWorkerFirst === undefined
                ? {}
                : { run_worker_first: options.assets.runWorkerFirst }),
            },
          }
        : {}),
    };
    const userClasses = [
      ...new Set(options.durableObjects.map((binding) => binding.className)),
    ].sort();
    return {
      metadata,
      doClasses: userClasses,
      sqliteClasses: userClasses,
      queueConsumers,
    };
  });
