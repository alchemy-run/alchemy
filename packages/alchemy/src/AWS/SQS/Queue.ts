import * as sqs from "@distilled.cloud/aws/sqs";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type QueueName = string;
export type QueueArn = `arn:aws:sqs:${RegionID}:${AccountID}:${QueueName}`;
export type QueueUrl = string;

export type QueueProps = {
  /**
   * Name of the queue.
   * @default ${app}-${stage}-${id}?.fifo
   */
  queueName?: string;
  /**
   * Delay in seconds for all messages in the queue (`0` - `900`).
   * @default 0
   */
  delaySeconds?: number;
  /**
   * Maximum message size in bytes (`1,024` - `1,048,576`).
   * @default 1048576
   */
  maximumMessageSize?: number;
  /**
   * Message retention period in seconds (`60` - `1,209,600`).
   * @default 345600
   */
  messageRetentionPeriod?: number;
  /**
   * Time in seconds for `ReceiveMessage` to wait for a message (`0` - `20`).
   * @default 0
   */
  receiveMessageWaitTimeSeconds?: number;
  /**
   * Visibility timeout in seconds (`0` - `43,200`).
   * @default 30
   */
  visibilityTimeout?: number;
  /**
   * Dead-letter queue redrive policy. Failed messages are moved to the
   * dead-letter queue after `maxReceiveCount` receive attempts. The
   * dead-letter queue must be the same type (a FIFO source requires a
   * FIFO dead-letter queue).
   */
  redrivePolicy?: {
    /**
     * The ARN of the dead-letter queue that failed messages are moved to.
     */
    deadLetterTargetArn: string;
    /**
     * The number of times a message is received before it is moved to the
     * dead-letter queue (`1` - `1000`).
     */
    maxReceiveCount: number;
  };
  /**
   * Redrive-allow policy. Set on the **dead-letter queue** to authorize
   * which source queues may use it.
   */
  redriveAllowPolicy?: {
    /**
     * Whether all, none, or a specified list of source queues may use this
     * queue as a dead-letter queue.
     */
    redrivePermission: "allowAll" | "denyAll" | "byQueue";
    /**
     * The ARNs of the source queues permitted to use this dead-letter
     * queue. Only valid (and required) when `redrivePermission` is
     * `byQueue` (up to 10 ARNs).
     */
    sourceQueueArns?: string[];
  };
  /**
   * An access-control policy document (IAM policy JSON) attached to the
   * queue. Provided as a JSON string or a plain object. Merged with any
   * policy statements contributed by capability bindings.
   */
  policy?: string | Record<string, any>;
  /**
   * The ID, alias, or ARN of a KMS key for server-side encryption (SSE-KMS).
   * Use `alias/aws/sqs` for the AWS-managed SQS key. Mutually exclusive with
   * `sqsManagedSseEnabled`.
   */
  kmsMasterKeyId?: string;
  /**
   * The length of time, in seconds, that SQS reuses a data key before
   * calling KMS again (`60` - `86,400`). Only meaningful with
   * `kmsMasterKeyId`.
   * @default 300
   */
  kmsDataKeyReusePeriodSeconds?: number;
  /**
   * Enables server-side encryption using SQS-owned keys (SSE-SQS).
   * Mutually exclusive with `kmsMasterKeyId`.
   * @default false
   */
  sqsManagedSseEnabled?: boolean;
  /**
   * Tags to apply to the queue. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
} & (
  | {
      fifo?: false;
      contentBasedDeduplication?: undefined;
      deduplicationScope?: undefined;
      fifoThroughputLimit?: undefined;
    }
  | {
      fifo: true;
      /**
       * Enables content-based deduplication for FIFO queues. Only valid when `fifo` is `true`.
       * @default false
       */
      contentBasedDeduplication?: boolean;
      /**
       * Specifies whether message deduplication occurs at the message group or queue level.
       * Valid values are `messageGroup` and `queue`. Only valid when `fifo` is `true`.
       */
      deduplicationScope?: "messageGroup" | "queue";
      /**
       * Specifies whether the FIFO queue throughput quota applies to the entire queue or per message group.
       * Valid values are `perQueue` and `perMessageGroupId`. Only valid when `fifo` is `true`.
       */
      fifoThroughputLimit?: "perQueue" | "perMessageGroupId";
    }
);

export interface Queue extends Resource<
  "AWS.SQS.Queue",
  QueueProps,
  {
    queueUrl: string;
    queueName: QueueName;
    queueArn: QueueArn;
  },
  {
    policyStatements: PolicyStatement[];
  },
  Providers
> {}

/**
 * An Amazon SQS queue for reliable, decoupled message processing.
 *
 * `Queue` owns the lifecycle of a standard or FIFO SQS queue. A queue name
 * is auto-generated from the app, stage, and logical ID unless you provide
 * one explicitly. FIFO queues automatically append the `.fifo` suffix.
 * @resource
 * @section Creating Queues
 * @example Standard Queue
 * ```typescript
 * import * as SQS from "alchemy/AWS/SQS";
 *
 * const queue = yield* SQS.Queue("OrdersQueue");
 * ```
 *
 * @example FIFO Queue
 * ```typescript
 * const queue = yield* SQS.Queue("OrdersFifoQueue", {
 *   fifo: true,
 *   contentBasedDeduplication: true,
 * });
 * ```
 *
 * @example Queue with Custom Settings
 * ```typescript
 * const queue = yield* SQS.Queue("ProcessingQueue", {
 *   visibilityTimeout: 120,
 *   messageRetentionPeriod: 86400,
 *   receiveMessageWaitTimeSeconds: 20,
 * });
 * ```
 *
 * @section Dead-Letter Queues
 * @example Route failures to a dead-letter queue
 * ```typescript
 * const dlq = yield* SQS.Queue("OrdersDLQ");
 * const orders = yield* SQS.Queue("Orders", {
 *   redrivePolicy: {
 *     deadLetterTargetArn: dlq.queueArn,
 *     maxReceiveCount: 3,
 *   },
 * });
 * ```
 *
 * @example Authorize source queues on the dead-letter queue
 * ```typescript
 * const dlq = yield* SQS.Queue("OrdersDLQ", {
 *   redriveAllowPolicy: {
 *     redrivePermission: "byQueue",
 *     sourceQueueArns: [orders.queueArn],
 *   },
 * });
 * ```
 *
 * @section Encryption
 * @example SSE-SQS (SQS-managed keys)
 * ```typescript
 * const queue = yield* SQS.Queue("SecureQueue", {
 *   sqsManagedSseEnabled: true,
 * });
 * ```
 *
 * @example SSE-KMS (AWS-managed key)
 * ```typescript
 * const queue = yield* SQS.Queue("KmsQueue", {
 *   kmsMasterKeyId: "alias/aws/sqs",
 *   kmsDataKeyReusePeriodSeconds: 300,
 * });
 * ```
 *
 * @section Sending Messages
 * Bind send operations in the init phase and use them in runtime
 * handlers.
 *
 * @example Send a message from a handler
 * ```typescript
 * // init
 * const sendMessage = yield* SQS.SendMessage.bind(queue);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* sendMessage({
 *       MessageBody: JSON.stringify({ orderId: "123" }),
 *     });
 *     return HttpServerResponse.text("Queued");
 *   }),
 * };
 * ```
 *
 * @section Event Sources
 * Process messages from a queue using a Lambda event source mapping.
 * Messages are automatically deleted after successful processing.
 *
 * @example Process queue messages
 * ```typescript
 * // init
 * yield* SQS.messages(queue).process(
 *   Effect.fn(function* (message) {
 *     yield* Effect.log(`Received: ${message.body}`);
 *   }),
 * );
 * ```
 */
export const Queue = Resource<Queue>("AWS.SQS.Queue");

/**
 * Raised when a `Queue` is configured with both `kmsMasterKeyId` (SSE-KMS)
 * and `sqsManagedSseEnabled` (SSE-SQS). The two encryption modes are
 * mutually exclusive.
 */
export class SqsEncryptionConflict extends Data.TaggedError(
  "SqsEncryptionConflict",
)<{ message: string }> {}

const validateEncryption = (props: QueueProps) =>
  props.kmsMasterKeyId !== undefined && props.sqsManagedSseEnabled
    ? Effect.fail(
        new SqsEncryptionConflict({
          message:
            "kmsMasterKeyId (SSE-KMS) and sqsManagedSseEnabled (SSE-SQS) are mutually exclusive — set only one.",
        }),
      )
    : Effect.void;

export const QueueProvider = () =>
  Provider.effect(
    Queue,
    Effect.gen(function* () {
      const createQueueName = Effect.fn(function* (
        id: string,
        props: {
          queueName?: string | undefined;
          fifo?: boolean;
        },
      ) {
        if (props.queueName) {
          return props.queueName;
        }
        const baseName = yield* createPhysicalName({
          id,
          maxLength: props.fifo ? 80 - ".fifo".length : 80,
        });
        return props.fifo ? `${baseName}.fifo` : baseName;
      });
      const buildPolicy = (
        props: QueueProps,
        bindings: ResourceBinding<Queue["Binding"]>[],
      ): string | undefined => {
        const bindingStatements = bindings.flatMap(
          (p) => p.data.policyStatements,
        );
        let userStatements: any[] = [];
        if (props.policy !== undefined) {
          const doc =
            typeof props.policy === "string"
              ? JSON.parse(props.policy)
              : props.policy;
          const stmt = doc?.Statement;
          userStatements = Array.isArray(stmt) ? stmt : stmt ? [stmt] : [];
        }
        const statements = [...userStatements, ...bindingStatements];
        if (statements.length === 0) return undefined;
        return JSON.stringify({
          Version: "2012-10-17",
          Statement: statements,
        });
      };
      // Build the desired attribute map. Keys present here are reconciled
      // against observed cloud state. An empty-string value explicitly
      // CLEARS an attribute (SQS interprets `""` as "remove"); `undefined`
      // means "leave alone" and is filtered out before diffing.
      const createAttributes = (
        props: QueueProps,
        bindings: ResourceBinding<Queue["Binding"]>[],
      ) => {
        // Removable attributes always emit a key: the desired value when set,
        // or "" to clear when the prop is absent. This lets the delta loop
        // converge when a user removes redrive/policy/kms props.
        const redrivePolicy = props.redrivePolicy
          ? JSON.stringify({
              deadLetterTargetArn: props.redrivePolicy.deadLetterTargetArn,
              maxReceiveCount: props.redrivePolicy.maxReceiveCount,
            })
          : "";
        const redriveAllowPolicy = props.redriveAllowPolicy
          ? JSON.stringify({
              redrivePermission: props.redriveAllowPolicy.redrivePermission,
              ...(props.redriveAllowPolicy.sourceQueueArns
                ? { sourceQueueArns: props.redriveAllowPolicy.sourceQueueArns }
                : {}),
            })
          : "";
        const policy = buildPolicy(props, bindings) ?? "";

        const baseAttributes: Record<string, string | undefined> = {
          DelaySeconds: props.delaySeconds?.toString(),
          MaximumMessageSize: props.maximumMessageSize?.toString(),
          MessageRetentionPeriod: props.messageRetentionPeriod?.toString(),
          ReceiveMessageWaitTimeSeconds:
            props.receiveMessageWaitTimeSeconds?.toString(),
          VisibilityTimeout: props.visibilityTimeout?.toString(),
          RedrivePolicy: redrivePolicy,
          RedriveAllowPolicy: redriveAllowPolicy,
          Policy: policy,
          KmsMasterKeyId: props.kmsMasterKeyId,
          KmsDataKeyReusePeriodSeconds:
            props.kmsDataKeyReusePeriodSeconds?.toString(),
          SqsManagedSseEnabled:
            props.sqsManagedSseEnabled === undefined
              ? undefined
              : props.sqsManagedSseEnabled
                ? "true"
                : "false",
        };

        if (props.fifo) {
          return {
            ...baseAttributes,
            FifoQueue: "true",
            FifoThroughputLimit: props.fifoThroughputLimit,
            ContentBasedDeduplication: props.contentBasedDeduplication
              ? "true"
              : "false",
            DeduplicationScope: props.deduplicationScope,
          };
        }

        return baseAttributes;
      };
      return Queue.Provider.of({
        stables: ["queueName", "queueUrl", "queueArn"],
        // Enumerate every queue in the ambient account/region. `listQueues`
        // returns queue URLs (paginated), which we hydrate into the exact `read`
        // shape. A queue can vanish between enumeration and hydration, so we
        // tolerate the typed `QueueDoesNotExist` per item and drop it.
        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const urls = yield* sqs.listQueues.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.QueueUrls ?? []),
              ),
            );
            const items = yield* Effect.forEach(
              urls,
              (queueUrl) =>
                sqs
                  .getQueueAttributes({
                    QueueUrl: queueUrl,
                    AttributeNames: ["QueueArn"],
                  })
                  .pipe(
                    Effect.map((r) => {
                      const queueName =
                        r.Attributes?.QueueArn?.split(":").pop() ??
                        queueUrl.split("/").pop()!;
                      const queueArn =
                        `arn:aws:sqs:${region}:${accountId}:${queueName}` as const;
                      return { queueName, queueUrl, queueArn };
                    }),
                    Effect.catchTag("QueueDoesNotExist", () =>
                      Effect.succeed(undefined),
                    ),
                  ),
              { concurrency: 10 },
            );
            return items.filter(
              (item): item is Queue["Attributes"] => item !== undefined,
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const queueName =
            output?.queueName ?? (yield* createQueueName(id, olds ?? {}));
          const url = yield* sqs.getQueueUrl({ QueueName: queueName }).pipe(
            Effect.map((r) => r.QueueUrl),
            Effect.catchTag("QueueDoesNotExist", () =>
              Effect.succeed(undefined),
            ),
          );
          if (!url) return undefined;
          const queueArn =
            `arn:aws:sqs:${region}:${accountId}:${queueName}` as const;
          const tagsResp = yield* sqs.listQueueTags({ QueueUrl: url }).pipe(
            Effect.map((r) => r.Tags ?? {}),
            Effect.catch(() => Effect.succeed({} as Record<string, string>)),
          );
          const attrs = {
            queueName,
            queueUrl: url,
            queueArn,
          };
          return (yield* hasAlchemyTags(id, tagsResp)) ? attrs : Unowned(attrs);
        }),
        diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
          if (!isResolved(news)) return undefined;
          yield* validateEncryption(news);
          const oldFifo = olds.fifo ?? false;
          const newFifo = news.fifo ?? false;
          if (oldFifo !== newFifo) {
            return { action: "replace" } as const;
          }
          const oldQueueName = yield* createQueueName(id, olds);
          const newQueueName = yield* createQueueName(id, news);
          if (oldQueueName !== newQueueName) {
            return { action: "replace" } as const;
          }
          // Return undefined to allow update function to be called for other attribute changes
        }),
        reconcile: Effect.fn(function* ({
          id,
          news = {},
          output,
          session,
          bindings,
        }) {
          yield* validateEncryption(news);
          const { accountId, region } = yield* AWSEnvironment.current;
          const queueName =
            output?.queueName ?? (yield* createQueueName(id, news));
          const queueArn =
            output?.queueArn ??
            (`arn:aws:sqs:${region}:${accountId}:${queueName}` as const);
          const desiredAttributes = createAttributes(news, bindings);
          const internalTags = yield* createInternalTags(id);

          // Observe — find the queue's URL or create it.
          //
          // We never trust a stale `output.queueUrl` blindly: if the queue was
          // deleted out-of-band, downstream API calls fail with
          // `QueueDoesNotExist` and we recreate. This keeps the reconciler
          // convergent regardless of the starting cloud state.
          let queueUrl = yield* sqs.getQueueUrl({ QueueName: queueName }).pipe(
            Effect.map((r) => r.QueueUrl!),
            Effect.catchTag("QueueDoesNotExist", () =>
              Effect.succeed(undefined),
            ),
          );

          if (queueUrl === undefined) {
            // `createQueue` is idempotent for identical params; with different
            // params it raises `QueueNameExists`. We pass the desired attrs so
            // first-create lands fully configured, and tolerate the race where
            // a peer reconciler created it concurrently.
            // SQS rejects empty-string attribute values on create (they're
            // only meaningful as a "clear" signal during update), so drop
            // any empty-string desired attrs from the initial create.
            const createAttrs: Record<string, string> = {};
            for (const [key, value] of Object.entries(desiredAttributes)) {
              if (value === undefined || value === "") continue;
              createAttrs[key] = value;
            }
            queueUrl = yield* sqs
              .createQueue({
                QueueName: queueName,
                Attributes: createAttrs,
                tags: { ...internalTags, ...news.tags },
              })
              .pipe(
                Effect.retry({
                  while: (e) => e._tag === "QueueDeletedRecently",
                  schedule: Schedule.fixed(1000).pipe(
                    Schedule.tapOutput((i) =>
                      session.note(
                        `Queue was deleted recently, retrying... ${i + 1}s`,
                      ),
                    ),
                  ),
                }),
                // A `RedrivePolicy` referencing a just-created dead-letter
                // queue is transiently rejected with
                // `InvalidParameterValueException` until that DLQ's ARN is
                // visible to SQS. It's an eventual-consistency race, not a
                // genuine validation failure, so retry on a bounded schedule.
                Effect.retry({
                  while: (e) => e._tag === "InvalidParameterValueException",
                  schedule: Schedule.fixed(1000).pipe(
                    Schedule.both(Schedule.recurs(30)),
                  ),
                }),
                Effect.catchTag("QueueNameExists", () =>
                  sqs.getQueueUrl({ QueueName: queueName }),
                ),
                Effect.map((r) => r.QueueUrl!),
              );
          }

          // Sync attributes — diff observed cloud state against desired and
          // apply only the delta. SQS returns all attribute values as strings,
          // and `desiredAttributes` is already string-shaped, so equality
          // comparison is direct.
          // SQS is eventually consistent: a freshly-created queue can return
          // `QueueDoesNotExist` from `getQueueAttributes` for a few seconds
          // even after `createQueue` succeeded. Retry briefly so the
          // reconciler converges instead of failing the first deploy.
          const currentAttributes = yield* sqs
            .getQueueAttributes({
              QueueUrl: queueUrl,
              AttributeNames: ["All"],
            })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "QueueDoesNotExist",
                schedule: Schedule.fixed(1000).pipe(
                  Schedule.both(Schedule.recurs(30)),
                ),
              }),
              Effect.map((r) => r.Attributes ?? {}),
            );

          const attributeDelta: Record<string, string> = {};
          for (const [key, value] of Object.entries(desiredAttributes)) {
            if (value === undefined) continue;
            const current =
              currentAttributes[key as keyof typeof currentAttributes];
            // Desired-to-clear ("") only needs an API call when the attribute
            // is actually present; SQS rejects clearing an already-absent attr.
            if (value === "" && (current === undefined || current === "")) {
              continue;
            }
            if (current !== value) {
              attributeDelta[key] = value;
            }
          }
          if (Object.keys(attributeDelta).length > 0) {
            yield* sqs
              .setQueueAttributes({
                QueueUrl: queueUrl,
                Attributes: attributeDelta,
              })
              .pipe(
                Effect.retry({
                  while: (e) => e._tag === "QueueDoesNotExist",
                  schedule: Schedule.fixed(1000).pipe(
                    Schedule.both(Schedule.recurs(30)),
                  ),
                }),
              );
          }

          // Sync alchemy-owned tags. The `tags` parameter on `createQueue`
          // only applies on first create, so on adoption (or after a queue
          // was created without our tags) we fix them up here.
          const currentTags = yield* sqs
            .listQueueTags({ QueueUrl: queueUrl })
            .pipe(
              Effect.retry({
                while: (e) => e._tag === "QueueDoesNotExist",
                schedule: Schedule.fixed(1000).pipe(
                  Schedule.both(Schedule.recurs(30)),
                ),
              }),
              Effect.map((r) => r.Tags ?? {}),
              Effect.catch(() => Effect.succeed({} as Record<string, string>)),
            );
          // Merge user tags with internal Alchemy tags and diff against the
          // OBSERVED cloud tags (not olds) so adoption converges. User tags
          // can be removed, so we untag removed keys; internal tags are never
          // user-removable so they survive.
          const desiredTags: Record<string, string> = {
            ...(news.tags ?? {}),
            ...internalTags,
          };
          const { upsert, removed } = diffTags(
            currentTags as Record<string, string>,
            desiredTags,
          );
          if (upsert.length > 0) {
            yield* sqs
              .tagQueue({
                QueueUrl: queueUrl,
                Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
              })
              .pipe(
                Effect.retry({
                  while: (e) => e._tag === "QueueDoesNotExist",
                  schedule: Schedule.fixed(1000).pipe(
                    Schedule.both(Schedule.recurs(30)),
                  ),
                }),
              );
          }
          if (removed.length > 0) {
            yield* sqs
              .untagQueue({ QueueUrl: queueUrl, TagKeys: removed })
              .pipe(
                Effect.retry({
                  while: (e) => e._tag === "QueueDoesNotExist",
                  schedule: Schedule.fixed(1000).pipe(
                    Schedule.both(Schedule.recurs(30)),
                  ),
                }),
              );
          }

          yield* session.note(queueUrl);
          return {
            queueName,
            queueUrl,
            queueArn,
          };
        }),
        delete: Effect.fn(function* (input) {
          yield* sqs
            .deleteQueue({
              QueueUrl: input.output.queueUrl,
            })
            .pipe(Effect.catchTag("QueueDoesNotExist", () => Effect.void));
        }),
      });
    }),
  );
