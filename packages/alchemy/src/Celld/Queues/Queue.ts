import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource, isResourceOfType } from "../../Resource.ts";
import {
  withFleet,
  type CurrentFleet,
  type FleetResourceProps,
  type FleetResourceAttributes,
} from "../FleetContext.ts";
import type { Providers } from "../Providers.ts";
import {
  catalogOwner,
  ensureCatalog,
  fleetConnection,
  ownsCatalogRecord,
  readCatalog,
  retainCatalog,
} from "../ResourceCatalog.ts";

/** A persistent queue identity within the selected Celld fleet. */
export interface QueueProps extends FleetResourceProps {
  /** Fleet-scoped name. Omit to generate a unique physical name. */
  name?: string;
}

export interface Queue extends Resource<
  "Celld.Queues.Queue",
  QueueProps,
  FleetResourceAttributes & {
    /** Persistent queue name within the fleet, not a Cloudflare queue ID. */
    queueName: string;
    /** Native queue identity; Celld addresses queues by name. */
    queueId: string;
  },
  never,
  Providers | CurrentFleet
> {}

export const isQueue = (value: unknown): value is Queue =>
  isResourceOfType(value, "Celld.Queues.Queue");

/** Invalid Celld queue declaration. */
export class QueueConfigurationError extends Data.TaggedError(
  "Celld.Queues.ConfigurationError",
)<{
  readonly message: string;
}> {}

/** v0.5.0 queue names must be valid cell scopes. @internal */
export const validateQueueName = (name: string) =>
  name.length <= 255 &&
  name !== "." &&
  name !== ".." &&
  /^[a-zA-Z0-9_.:$-]+$/.test(name)
    ? Effect.void
    : Effect.fail(
        new QueueConfigurationError({
          message: `Invalid Celld queue name '${name}': use 1–255 ASCII letters, digits, _, -, ., :, or $; '.' and '..' are reserved.`,
        }),
      );

/**
 * A retained queue identity in the ambient Celld fleet. A producer or consumer
 * materializes the broker; the declaration reserves its name conditionally in
 * the backing store. Deletion retains messages and ownership. Renaming replaces
 * the identity; foreign retained claims cannot be automatically adopted.
 * Celld retains messages for four days and supports one push consumer per queue.
 * Pull consumers, HTTP queue APIs, and event subscriptions are unavailable.
 *
 * ### Declare a queue
 * **Example:** Bind a named queue in a Worker
 * ```typescript
 * const jobs = yield* Celld.Queues.Queue("Jobs", { name: "jobs" });
 * const writer = yield* Celld.Queues.WriteQueue(jobs);
 * ```
 *
 * @resource
 * @product Celld
 */
export const Queue = withFleet(Resource<Queue>("Celld.Queues.Queue"));

export const QueueProvider = () =>
  Provider.succeed(Queue, {
    stables: ["queueName", "queueId", "fleetId", "bucket"],
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return;
      if (
        news.fleetId !== olds.fleetId ||
        !deepEqual(news.bucket, olds.bucket) ||
        (news.name !== undefined &&
          news.name !== (output?.queueName ?? olds.name))
      )
        return { action: "replace" } as const;
    }),
    read: Effect.fn(function* ({ fqn, instanceId, olds, output }) {
      const connection = yield* fleetConnection(output ?? olds);
      const queueName =
        output?.queueName ??
        olds.name ??
        (yield* createPhysicalName({ id: fqn, instanceId }));
      yield* validateQueueName(queueName);
      const record = yield* readCatalog(connection, "queue", queueName);
      if (!record) return undefined;
      const desired = {
        ...record,
        fleetId: connection.fleetId,
        owner: yield* catalogOwner(fqn, instanceId),
      };
      const attrs = { ...connection, queueName, queueId: queueName };
      return ownsCatalogRecord(record, desired) ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ fqn, instanceId, news, output }) {
      const connection = yield* fleetConnection(news);
      const queueName =
        news.name ??
        output?.queueName ??
        (yield* createPhysicalName({ id: fqn, instanceId }));
      yield* validateQueueName(queueName);
      const record = yield* ensureCatalog(connection, {
        version: 1,
        kind: "queue",
        physicalId: queueName,
        label: queueName,
        fleetId: connection.fleetId,
        owner: yield* catalogOwner(fqn, instanceId),
        retained: false,
      });
      return {
        ...connection,
        queueName: record.physicalId,
        queueId: record.physicalId,
      };
    }),
    delete: Effect.fn(function* ({ fqn, instanceId, output }) {
      yield* retainCatalog(output, {
        version: 1,
        kind: "queue",
        physicalId: output.queueName,
        label: output.queueName,
        fleetId: output.fleetId,
        owner: yield* catalogOwner(fqn, instanceId),
        retained: true,
      });
    }),
  });
