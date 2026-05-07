import * as queues from "@distilled.cloud/cloudflare/queues";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

export type QueueConsumerProps = {
  /**
   * The queue ID to attach the consumer to.
   */
  queueId: string;
  /**
   * Name of the Worker script that will consume messages.
   */
  scriptName: string;
  /**
   * Optional dead letter queue name for failed messages.
   */
  deadLetterQueue?: string;
  /**
   * Consumer settings.
   */
  settings?: {
    /**
     * The maximum number of messages per batch.
     * @default 10
     */
    batchSize?: number;
    /**
     * The maximum number of concurrent consumer invocations.
     */
    maxConcurrency?: number;
    /**
     * The maximum number of retries for a message.
     * @default 3
     */
    maxRetries?: number;
    /**
     * The maximum time to wait for a batch to fill, in milliseconds.
     * @default 5000
     */
    maxWaitTimeMs?: number;
    /**
     * The number of seconds to wait before retrying a message.
     */
    retryDelay?: number;
  };
};

export type QueueConsumer = Resource<
  "Cloudflare.QueueConsumer",
  QueueConsumerProps,
  {
    consumerId: string;
    queueId: string;
    scriptName: string;
    accountId: string;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Queue Consumer that processes messages from a Queue.
 *
 * Register a Worker as a consumer of a Queue. The Worker's `queue()`
 * handler will be invoked with batches of messages.
 *
 * Cloudflare allows at most one Worker consumer per queue (HTTP-pull
 * consumers can coexist). The reconciler enforces this: if the queue
 * already has a Worker consumer pointing at a different script, the
 * deploy fails with a clear error rather than silently adopting it.
 *
 * @section Registering a Consumer
 * @example Basic consumer
 * ```typescript
 * const queue = yield* Cloudflare.Queue("MyQueue");
 * const worker = yield* Cloudflare.Worker("Worker", { ... });
 *
 * yield* Cloudflare.QueueConsumer("MyConsumer", {
 *   queueId: queue.queueId,
 *   scriptName: "my-worker",
 * });
 * ```
 *
 * @example Consumer with settings
 * ```typescript
 * yield* Cloudflare.QueueConsumer("MyConsumer", {
 *   queueId: queue.queueId,
 *   scriptName: "my-worker",
 *   settings: {
 *     batchSize: 50,
 *     maxRetries: 5,
 *     maxWaitTimeMs: 10000,
 *   },
 * });
 * ```
 */
export const QueueConsumer = Resource<QueueConsumer>(
  "Cloudflare.QueueConsumer",
);

type ObservedConsumer = {
  consumerId: string;
  script: string | undefined;
};

const toObserved = (c: {
  consumerId?: string | null;
  script?: string | null;
  type?: "worker" | "http_pull" | null;
}): ObservedConsumer | undefined =>
  c.consumerId && c.type === "worker"
    ? { consumerId: c.consumerId, script: c.script ?? undefined }
    : undefined;

export const QueueConsumerProvider = () =>
  Provider.effect(
    QueueConsumer,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const createConsumer = yield* queues.createConsumer;
      const getConsumer = yield* queues.getConsumer;
      const updateConsumer = yield* queues.updateConsumer;
      const deleteConsumer = yield* queues.deleteConsumer;

      // Cloudflare allows a single Worker consumer per queue, so the
      // first match in the paginated stream is the only one. Using
      // `.items` defeats single-page lookups that would otherwise
      // miss late-arriving consumers under eventual consistency.
      const findWorkerConsumer = (
        acct: string,
        queueId: string,
      ): Effect.Effect<ObservedConsumer | undefined, any, any> =>
        queues.listConsumers.items({ accountId: acct, queueId }).pipe(
          Stream.map(toObserved),
          Stream.filter((c): c is ObservedConsumer => c !== undefined),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
        );

      return {
        stables: ["consumerId", "accountId"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" } as const;
          }
          // Queue change requires replacement
          if (output?.queueId && news.queueId !== output.queueId) {
            return { action: "replace" } as const;
          }
          // Script change requires replacement
          if (output?.scriptName && news.scriptName !== output.scriptName) {
            return { action: "replace" } as const;
          }
          // Settings change is an update
          if (
            JSON.stringify(olds.settings ?? {}) !==
            JSON.stringify(news.settings ?? {})
          ) {
            return { action: "update" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          const acct = output?.accountId ?? accountId;
          const queueId =
            output?.queueId ?? (news.queueId as unknown as string);

          // Observe — prefer the cached consumerId, then fall back to
          // listConsumers (paginated) to recover from out-of-band
          // deletes or partial state-persistence failures. The list
          // scan also surfaces a different-script worker consumer so
          // we can fail with a useful error before a duplicate create.
          let observed: ObservedConsumer | undefined;
          if (output?.consumerId) {
            const fetched = yield* getConsumer({
              accountId: acct,
              queueId,
              consumerId: output.consumerId,
            }).pipe(
              Effect.catchTag("ConsumerNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
            observed = fetched ? toObserved(fetched) : undefined;
          }
          if (!observed) {
            observed = yield* findWorkerConsumer(acct, queueId);
          }

          // If a worker consumer exists but for a different script,
          // surface that explicitly. Silent adoption would mean we'd
          // start managing a consumer the operator created for a
          // different worker — almost never what they want.
          if (
            observed &&
            observed.script !== undefined &&
            observed.script !== news.scriptName
          ) {
            return yield* Effect.die(
              `Cloudflare queue "${queueId}" already has a worker ` +
                `consumer for script "${observed.script}", but this ` +
                `resource is configured for "${news.scriptName}". Each ` +
                `queue can have only one worker consumer — delete the ` +
                `existing one or update scriptName to match before ` +
                `redeploying.`,
            );
          }

          // Ensure — create if missing. ConsumerAlreadyExists is the
          // race signal: another reconcile or peer beat us to it.
          // Re-run the lookup; the paginated stream tolerates the
          // single-page eventual-consistency window the previous
          // implementation missed.
          let consumerId: string;
          if (!observed) {
            const created = yield* createConsumer({
              accountId: acct,
              queueId,
              scriptName: news.scriptName,
              type: "worker",
              deadLetterQueue: news.deadLetterQueue,
              settings: news.settings,
            }).pipe(
              Effect.catchTag("ConsumerAlreadyExists", (cause) =>
                Effect.gen(function* () {
                  const match = yield* findWorkerConsumer(acct, queueId);
                  if (!match) {
                    return yield* Effect.die(
                      `Cloudflare reported a worker consumer already ` +
                        `exists on queue "${queueId}", but listConsumers ` +
                        `returned none. Retry the deploy; if this ` +
                        `persists, the queue is in an inconsistent ` +
                        `state. Underlying error: ${cause.message}`,
                    );
                  }
                  if (
                    match.script !== undefined &&
                    match.script !== news.scriptName
                  ) {
                    return yield* Effect.die(
                      `Cloudflare queue "${queueId}" already has a ` +
                        `worker consumer for script "${match.script}", ` +
                        `but this resource is configured for ` +
                        `"${news.scriptName}". Each queue can have only ` +
                        `one worker consumer — delete the existing one ` +
                        `or update scriptName to match before redeploying.`,
                    );
                  }
                  return match;
                }),
              ),
            );
            consumerId = created.consumerId!;
          } else {
            consumerId = observed.consumerId;
          }

          // Sync — Cloudflare replaces all mutable fields on
          // updateConsumer, so always issue this so adoption converges
          // and settings drift gets corrected on every reconcile.
          yield* updateConsumer({
            accountId: acct,
            queueId,
            consumerId,
            scriptName: news.scriptName,
            type: "worker",
            settings: news.settings,
            deadLetterQueue: news.deadLetterQueue,
          });

          return {
            consumerId,
            queueId,
            scriptName: news.scriptName!,
            accountId: acct,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteConsumer({
            accountId: output.accountId,
            queueId: output.queueId,
            consumerId: output.consumerId,
          }).pipe(Effect.catchTag("ConsumerNotFound", () => Effect.void));
        }),
        read: Effect.fn(function* ({ output }) {
          if (output?.consumerId) {
            const fetched = yield* getConsumer({
              accountId: output.accountId,
              queueId: output.queueId,
              consumerId: output.consumerId,
            }).pipe(
              Effect.catchTag("ConsumerNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
            if (fetched) {
              return {
                consumerId: fetched.consumerId!,
                queueId: output.queueId,
                scriptName:
                  ("script" in fetched && typeof fetched.script === "string"
                    ? fetched.script
                    : output.scriptName) ?? output.scriptName,
                accountId: output.accountId,
              };
            }
          }
          // Fallback: a state loss can leave us without a consumerId
          // even though the consumer is still alive on Cloudflare. The
          // queue allows only one worker consumer, so finding it via
          // listConsumers is unambiguous.
          if (output?.queueId && output?.accountId) {
            const match = yield* findWorkerConsumer(
              output.accountId,
              output.queueId,
            );
            if (match) {
              return {
                consumerId: match.consumerId,
                queueId: output.queueId,
                scriptName: match.script ?? output.scriptName,
                accountId: output.accountId,
              };
            }
          }
          return undefined;
        }),
      };
    }),
  );
