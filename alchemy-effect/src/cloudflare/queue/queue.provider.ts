import type { Queues } from "cloudflare/resources";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../physical-name.ts";
import { Account } from "../account.ts";
import { CloudflareApi } from "../api.ts";
import {
  Queue,
  type QueueAttr,
  type QueueProps,
  type QueueSettings,
} from "./queue.ts";

export const queueProvider = () =>
  Queue.provider.effect(
    Effect.gen(function* () {
      const api = yield* CloudflareApi;
      const accountId = yield* Account;

      const createQueueName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          return name ?? (yield* createPhysicalName({ id }));
        });

      const mapResult = <Props extends QueueProps>(
        result: Queues.Queue,
      ): QueueAttr<Props> =>
        ({
          queueId: result.queue_id!,
          queueName: result.queue_name!,
          accountId,
          settings: result.settings
            ? {
                deliveryDelay: result.settings.delivery_delay,
                deliveryPaused: result.settings.delivery_paused,
                messageRetentionPeriod: result.settings.message_retention_period,
              }
            : undefined,
          createdOn: result.created_on!,
          modifiedOn: result.modified_on!,
        }) as QueueAttr<Props>;

      const mapSettings = (
        settings: QueueSettings | undefined,
      ): Queues.QueueUpdateParams.Settings | undefined => {
        if (!settings) return undefined;
        return {
          delivery_delay: settings.deliveryDelay,
          delivery_paused: settings.deliveryPaused,
          message_retention_period: settings.messageRetentionPeriod,
        };
      };

      const createQueue = Effect.fn(function* (queueName: string) {
        return yield* api.queues
          .create({
            account_id: accountId,
            queue_name: queueName,
          })
          .pipe(Effect.map((r) => r as Queues.Queue));
      });

      const updateQueueSettings = Effect.fn(function* (
        queueId: string,
        queueName: string,
        settings: QueueSettings | undefined,
      ) {
        return yield* api.queues
          .edit(queueId, {
            account_id: accountId,
            queue_name: queueName,
            settings: mapSettings(settings),
          })
          .pipe(Effect.map((r) => r as Queues.Queue));
      });

      const getQueue = Effect.fn(function* (queueId: string) {
        return yield* api.queues
          .get(queueId, { account_id: accountId })
          .pipe(Effect.map((r) => r as Queues.Queue));
      });

      const listQueues = Effect.fn(function* () {
        const queues: Queues.Queue[] = [];
        for await (const queue of api.queues.list({ account_id: accountId })) {
          queues.push(queue);
        }
        return queues;
      });

      const deleteQueue = Effect.fn(function* (queueId: string) {
        yield* api.queues
          .delete(queueId, { account_id: accountId })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      });

      return {
        stables: ["queueId", "accountId"],

        diff: Effect.fn(function* ({ id, news, output }) {
          if (output.accountId !== accountId) {
            return { action: "replace" } as const;
          }

          const queueName = yield* createQueueName(id, news.name);
          if (queueName !== output.queueName) {
            return { action: "replace" } as const;
          }
        }),

        create: Effect.fn(function* ({ id, news, session }) {
          const queueName = yield* createQueueName(id, news.name);
          const existingQueues = yield* listQueues();
          const existing = existingQueues.find(
            (q) => q.queue_name === queueName,
          );

          if (existing) {
            if (news.adopt) {
              yield* session.note(`Adopting existing queue: ${queueName}`);
              if (news.settings) {
                const updated = yield* updateQueueSettings(
                  existing.queue_id!,
                  queueName,
                  news.settings,
                );
                return mapResult<QueueProps>(updated);
              }
              return mapResult<QueueProps>(existing);
            }
            return yield* Effect.fail(
              new Error(`Queue "${queueName}" already exists`),
            );
          }

          yield* session.note(`Creating queue: ${queueName}`);
          const queue = yield* createQueue(queueName);
          yield* session.note(queue.queue_id!);

          if (news.settings) {
            const updated = yield* updateQueueSettings(
              queue.queue_id!,
              queueName,
              news.settings,
            );
            return mapResult<QueueProps>(updated);
          }

          return mapResult<QueueProps>(queue);
        }),

        update: Effect.fn(function* ({ id, news, output, session }) {
          const queueName = yield* createQueueName(id, news.name);
          const currentSettings = output.settings;
          const newSettings = news.settings;

          const settingsChanged =
            currentSettings?.deliveryDelay !== newSettings?.deliveryDelay ||
            currentSettings?.deliveryPaused !== newSettings?.deliveryPaused ||
            currentSettings?.messageRetentionPeriod !==
              newSettings?.messageRetentionPeriod;

          if (settingsChanged) {
            yield* session.note(`Updating queue settings: ${queueName}`);
            const updated = yield* updateQueueSettings(
              output.queueId,
              queueName,
              newSettings,
            );
            return mapResult<QueueProps>(updated);
          }

          return output;
        }),

        delete: Effect.fn(function* ({ output, olds }) {
          if (olds.delete !== false) {
            yield* deleteQueue(output.queueId);
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.queueId) {
            return yield* getQueue(output.queueId).pipe(
              Effect.map(mapResult<QueueProps>),
              Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            );
          }

          const queueName = yield* createQueueName(id, olds?.name);
          const queues = yield* listQueues();
          const match = queues.find((q) => q.queue_name === queueName);

          if (match) {
            return mapResult<QueueProps>(match);
          }

          return undefined;
        }),
      };
    }),
  );
