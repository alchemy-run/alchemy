import * as durableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as workflows from "@distilled.cloud/cloudflare/workflows";
import { isResolved } from "alchemy/Diff";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { passMarker } from "./Version.ts";

export interface MigrationProps {
  /** The Domain's Worker, which hosts the old classes and the migration Workflow. */
  scriptName: string;
  /** The Workflow that moves a batch of old objects. */
  workflowName: string;
  /**
   * Each old (Domain version 0) class the Worker's code can move, and the
   * route its objects move to in the shared class.
   */
  classes: { className: string; route: string }[];
  /** The Worker's Durable Object namespaces by class: the old classes still live among them. */
  namespaces: Record<string, string>;
  /** The Worker's code and settings, so every upload moves what the last one couldn't. */
  deployment: unknown;
  /**
   * How long a deploy waits for the move, in seconds.
   * @default 1800
   */
  timeoutSeconds?: number;
}

export interface MigrationAttrs {
  accountId: string;
  workflowName: string;
  /** The Workflow instances the last deploy waited for. */
  instanceIds: string[];
  /** How many objects the last deploy moved. */
  moved: number;
}

const MigrationTypeId = "Cloudflare.Domain.Migration";

/**
 * Moves a Domain's objects from the classes of Domain version 0 (one class
 * per aggregate, view, policy, projection, stream and saga of each model) to
 * the one class of version 1. The Durable Object platform declares it: you
 * don't declare it yourself.
 *
 * ### What a deploy waits for <!-- api-prose -->
 *
 * The upgrade deploy keeps each old class next to the new one. This lists
 * every object of the old classes that holds data, and a Workflow on the
 * Worker hands each to its key's object in the new class, which copies its
 * storage, alarm included, and empties it. A key called before its turn moves
 * on that call, so nothing is served from an empty object.
 *
 * Cloudflare lists an object a few minutes after it is first written, so a
 * later deploy moves any the first one couldn't see, and deletes each old
 * class once none of its objects holds data. A deploy is safe to repeat and
 * to interrupt: an object that has moved is empty and isn't listed again.
 *
 * @resource
 * @product Durable Objects
 */
export interface Migration extends Resource<
  typeof MigrationTypeId,
  MigrationProps,
  MigrationAttrs
> {}

export const Migration = Resource<Migration>(MigrationTypeId);

export class MigrationFailed extends Data.TaggedError("MigrationFailed")<{
  readonly message: string;
  readonly instanceId: string;
}> {}

export class MigrationStillRunning extends Data.TaggedError("MigrationStillRunning")<{
  readonly message: string;
}> {}

/** Old objects one Workflow instance moves: its params stay well under the limit. */
const CHUNK = 1_000;
const POLL = "2 seconds";

/** Workflows answers for a Workflow uploaded moments before with an internal error for a while. */
const retryInternal = {
  while: (error: { readonly _tag: string }) => error._tag === "WorkflowInternalError",
  schedule: Schedule.spaced("2 seconds"),
  times: 30,
};

const hash = (text: string) => {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

const MigrationLive = () =>
  Provider.succeed(Migration, {
    stables: ["accountId", "workflowName"],
    diff: Effect.fn(function* ({ news }) {
      // While the Worker keeps an old class, each upload may leave objects to move.
      if (!isResolved(news)) return { action: "update" } as const;
      if (news.classes.some(({ className }) => news.namespaces?.[className] !== undefined))
        return { action: "update" } as const;
    }),
    read: Effect.fn(function* ({ output }) {
      return output;
    }),
    reconcile: Effect.fn(function* ({ instanceId: resource, news, session }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const started = yield* Clock.currentTimeMillis;
      // Every object listed from here on is moved by this pass.
      const listedAt = Math.floor(started / 1000);
      const timeout = (news.timeoutSeconds ?? 1800) * 1000;

      // The old classes the upload kept, and their objects that still hold data.
      const batches: Array<{ className: string; route: string; ids: string[] }> = [];
      for (const { className, route } of news.classes) {
        const id = news.namespaces[className];
        if (id === undefined) continue;
        const objects = yield* durableObjects.listNamespaceObjects.items({ accountId, id }).pipe(
          Stream.filter((object) => object.hasStoredData === true),
          Stream.runCollect,
        );
        const ids = Array.from(objects, (object) => object.id).filter(
          (id): id is string => typeof id === "string",
        );
        for (let i = 0; i < ids.length; i += CHUNK)
          batches.push({ className, route, ids: ids.slice(i, i + CHUNK) });
      }
      const total = batches.reduce((sum, batch) => sum + batch.ids.length, 0);
      const attrs = { accountId, workflowName: news.workflowName };

      /** Start an instance, or find it started. */
      const create = (instanceId: string, params: object) =>
        workflows
          .createInstance({ accountId, workflowName: news.workflowName, instanceId, params })
          .pipe(
            Effect.asVoid,
            Effect.catchTag("InstanceAlreadyExists", () => Effect.void),
            // The Workflow is uploaded with the Worker: it can take a moment to appear.
            Effect.retry({
              while: (error) =>
                error._tag === "WorkflowNotFound" || error._tag === "WorkflowInternalError",
              schedule: Schedule.spaced("2 seconds"),
              times: 30,
            }),
          );
      /**
       * Record each class's complete pass as an instance of the Workflow that
       * moves nothing: the Worker's next upload reads them, and deletes a
       * class once a pass has seen every object written before the move.
       */
      const markPasses = Effect.forEach(
        news.classes.filter(({ className }) => news.namespaces[className] !== undefined),
        ({ className, route }) =>
          create(passMarker(className, listedAt), { className, route, ids: [] }),
        { discard: true },
      );
      if (total === 0) {
        yield* markPasses;
        return { ...attrs, instanceIds: [], moved: 0 };
      }

      const instanceIds: Array<string> = [];
      for (const batch of batches) {
        const instanceId = `migrate-${resource.slice(0, 12)}-${started.toString(36)}-${hash(`${batch.className}|${batch.ids.join(",")}`)}`;
        yield* create(instanceId, batch);
        instanceIds.push(instanceId);
      }

      const pending = new Map(instanceIds.map((id, i) => [id, batches[i]!.ids.length]));
      let moved = 0;
      while (pending.size > 0) {
        for (const [instanceId, size] of pending) {
          const status = yield* workflows
            .getInstance({ accountId, workflowName: news.workflowName, instanceId, simple: true })
            .pipe(Effect.retry(retryInternal));
          if (status.status === "complete") {
            pending.delete(instanceId);
            moved += size;
          } else if (status.status === "errored" || status.status === "terminated") {
            const failed = yield* workflows
              .getInstance({ accountId, workflowName: news.workflowName, instanceId })
              .pipe(Effect.retry(retryInternal));
            return yield* new MigrationFailed({
              message: `Moving Domain objects to the shared class ended ${status.status}: ${failed.error?.message ?? "no error reported"}. Deploy again to move the rest; nothing moved is lost.`,
              instanceId,
            });
          }
        }
        if (pending.size === 0) break;
        const elapsed = (yield* Clock.currentTimeMillis) - started;
        if (elapsed > timeout)
          return yield* new MigrationStillRunning({
            message: `Moving Domain objects to the shared class is still running after ${Math.round(elapsed / 1000)}s (${moved}/${total} moved). It keeps running on Cloudflare; the next deploy moves the rest.`,
          });
        yield* session.note(
          `Moving Domain objects to the shared class: ${moved}/${total} (${Math.round(elapsed / 1000)}s) ...`,
          { kind: "status" },
        );
        yield* Effect.sleep(POLL);
      }
      yield* markPasses;
      yield* session.note(`Moved ${total} Domain objects to the shared class`, { kind: "status" });
      return { ...attrs, instanceIds, moved: total };
    }),
    // The instances end by themselves; the old classes go with the Worker's next upload.
    delete: Effect.fn(function* () {}),
  });

/** In `alchemy dev` nothing was deployed before: nothing to move. */
const MigrationLocal = () =>
  Provider.succeed(Migration, {
    diff: Effect.fn(function* () {
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      return output;
    }),
    reconcile: Effect.fn(function* ({ news }) {
      return { accountId: "dev", workflowName: news.workflowName, instanceIds: [], moved: 0 };
    }),
    delete: Effect.fn(function* () {}),
  });

export const MigrationProvider = () =>
  ProviderLayer.dual(Migration, {
    local: () => MigrationLocal(),
    live: () => MigrationLive(),
  });
