import * as queue from "@distilled.cloud/modal/queue";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  type EnvironmentInput,
  envNameOf,
  environmentNames,
  environmentOf,
  isGeneratedName,
  listAll,
  objectName,
} from "./internal.ts";
import { declarable } from "./internal/Declared.ts";
import type { Providers } from "./Providers.ts";
import { isRuntimeName } from "./RuntimeOwner.ts";

export class QueueUnexpectedResponse extends Data.TaggedError("Modal.QueueUnexpectedResponse")<{
  readonly message: string;
}> {}

export interface QueueProps {
  /**
   * Queue name, unique per environment. If omitted, a unique name is
   * generated from the stack, stage and logical ID. Changing it replaces the
   * queue (Modal can't rename queues).
   */
  name?: string;
  /**
   * Environment the queue lives in. Changing it replaces the queue.
   * @default the workspace's default environment
   */
  environment?: EnvironmentInput;
}

export interface QueueAttributes {
  /** Queue ID (`qu-…`). */
  queueId: string;
  /** Queue name. */
  name: string;
  /** Environment name, or `undefined` for the workspace default. */
  environment: string | undefined;
}

/**
 * A Modal Queue: a distributed FIFO queue shared by every container, Sandbox
 * and client in the workspace, with optional named partitions. Items expire
 * 24 hours after they are put (partitions can set their own TTL).
 *
 * Bind it with {@link WriteQueue} to put items, {@link ReadQueue} to take
 * them, or {@link ReadWriteQueue} for both, from a Worker, Lambda or any
 * other runtime. Values travel as bytes: the bindings encode them as JSON by
 * default.
 *
 * Modal queues have no tags. Ownership is inferred from Alchemy state: a
 * queue found under an explicit `name` without prior state is reported as
 * unowned.
 *
 * ### Creating a Queue
 * **Example:** A queue with a generated name
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Jobs = Modal.Queue("Jobs", {});
 * ```
 *
 * **Example:** A named queue in an environment
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Agents = Modal.Environment("Agents", {});
 * export const Tasks = Modal.Queue("Tasks", { name: "tasks", environment: Agents });
 * ```
 *
 * ### Producing from a Worker
 * **Example:** Bind write access and put a job
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Jobs } from "./Storage.ts";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const jobs = yield* Modal.WriteQueue(Jobs);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* jobs.put({ repo: "alchemy-run/alchemy", command: "pnpm test" });
 *         return HttpServerResponse.text("queued");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.WriteQueueHttp)),
 * ) {}
 * ```
 *
 * ### Looking up an existing queue
 * `Queue.lookup` references a queue Alchemy doesn't manage (created with
 * the Modal CLI or by another stack). It is read during plan/deploy, never
 * created, updated or deleted.
 *
 * **Example:** Reference an existing queue
 * ```typescript
 * const jobs = Modal.Queue.lookup({ name: "jobs" });
 * ```
 *
 * @resource
 * @product Queue
 */
export const Queue = declarable<Queue>()(Resource<Queue>("Modal.Queue"));

export type Queue = Resource<
  "Modal.Queue",
  QueueProps,
  QueueAttributes,
  never,
  Providers,
  QueueLookup
>;

/**
 * Props for {@link Queue.lookup}: find a queue this stack
 * doesn't manage by its name.
 */
export interface QueueLookup {
  /** Queue name. */
  name: string;
  /**
   * Modal environment the object lives in.
   * @default the workspace's default environment
   */
  environment?: string;
}

/** A queue by name, or `undefined` when missing. */
export const lookupQueue = Effect.fn(function* (
  getOrCreate: Effect.Success<typeof queue.queueGetOrCreate>,
  name: string,
  env: string | undefined,
) {
  const found = yield* getOrCreate({
    deploymentName: name,
    environmentName: environmentOf(env),
    objectCreationType: "OBJECT_CREATION_TYPE_UNSPECIFIED",
  }).pipe(Effect.catchTag("QueueNotFound", () => Effect.undefined));
  if (!found?.queueId) return undefined;
  return { queueId: found.queueId, name, environment: env } satisfies QueueAttributes;
});

/**
 * Get a queue by name, creating it when missing: the one implementation behind
 * {@link Queue}'s reconcile and the runtime {@link CreateQueue} client.
 */
export const ensureQueue = Effect.fn(function* (
  getOrCreate: Effect.Success<typeof queue.queueGetOrCreate>,
  name: string,
  env: string | undefined,
) {
  const created = yield* getOrCreate({
    deploymentName: name,
    environmentName: environmentOf(env),
    objectCreationType: "OBJECT_CREATION_TYPE_CREATE_IF_MISSING",
  });
  if (!created.queueId) {
    return yield* new QueueUnexpectedResponse({
      message: `Modal returned no id for queue ${name}`,
    });
  }
  return { queueId: created.queueId, name, environment: env } satisfies QueueAttributes;
});

export const QueueProvider = () =>
  Provider.effect(
    Queue,
    Effect.gen(function* () {
      const observe = Effect.fn(function* (
        queueId: string | undefined,
        name: string,
        env: string | undefined,
      ) {
        if (queueId !== undefined) {
          const byId = yield* queue
            .queueGetById({ queueId })
            .pipe(Effect.catchTag("QueueNotFound", () => Effect.undefined));
          if (byId?.queueId) {
            return {
              queueId: byId.queueId,
              name: byId.metadata?.name ?? name,
              environment: env,
            } satisfies QueueAttributes;
          }
        }
        return yield* lookupQueue(yield* queue.queueGetOrCreate, name, env);
      });

      return {
        stables: ["queueId", "name", "environment"],
        diff: Effect.fn(function* ({ id, news, olds, output }) {
          if (!isResolved(news)) return undefined;
          if (envNameOf(news.environment) !== envNameOf(olds?.environment))
            return { action: "replace" } as const;
          const name = yield* objectName(id, news.name);
          if (output !== undefined && name !== output.name) return { action: "replace" } as const;
          return undefined;
        }),
        lookup: Effect.fn(function* ({ name, environment }) {
          return yield* observe(undefined, name, environment);
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.name ?? (yield* objectName(id, olds?.name));
          const observed = yield* observe(output?.queueId, name, envNameOf(olds?.environment));
          if (!observed) return undefined;
          return output !== undefined || olds?.name === undefined ? observed : Unowned(observed);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.name ?? (yield* objectName(id, news.name));
          const current = yield* observe(output?.queueId, name, envNameOf(news.environment));
          if (current) return current;
          yield* session.note(`Creating queue ${name}...`);
          return yield* ensureQueue(
            yield* queue.queueGetOrCreate,
            name,
            envNameOf(news.environment),
          );
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* queue
            .deleteQueue({ queueId: output.queueId })
            .pipe(Effect.catchTag("QueueNotFound", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const envs = yield* environmentNames;
          const all: QueueAttributes[] = [];
          for (const env of envs) {
            const items = yield* listAll(
              (pagination) =>
                queue
                  .listQueue({ environmentName: env, pagination })
                  .pipe(Effect.map((response) => response.queues ?? [])),
              (item) => item.createdAt,
            );
            for (const item of items) {
              if (!item.queueId || !(isGeneratedName(item.name) || isRuntimeName(item.name)))
                continue;
              all.push({ queueId: item.queueId, name: item.name ?? "", environment: env });
            }
          }
          return all;
        }),
      };
    }),
  );
