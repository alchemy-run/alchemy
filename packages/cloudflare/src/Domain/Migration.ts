import type { Progress } from "@alchemy.run/domain/FanOut";
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
import { progressOf, worthRestarting } from "./Backfill.ts";
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
  /** How many Workflow instances the last deploy waited for. */
  instances: number;
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

/** Ids per page of the run's frontier: the root paces pages, so small ones pace finely. */
const PAGE = 100;
/** Pages one `add` instance hands over: its params stay well under the 1 MiB limit. */
const PAGES_PER_ADD = 50;
/** Instances one bulk call starts. */
const BULK = 100;
const POLL = "3 seconds";
/** How many times an instance that started before the Worker reached its edge is started again, and how soon. */
const MAX_RESTARTS = 30;
const RESTART_DELAY = "2 seconds";

/** Workflows answers for a Workflow uploaded moments before with an internal error for a while. */
const retryInternal = {
  while: (error: { readonly _tag: string }) => error._tag === "WorkflowInternalError",
  schedule: Schedule.spaced("2 seconds"),
  times: 30,
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
    reconcile: Effect.fn(function* ({ news, session }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const workflowName = news.workflowName;
      const started = yield* Clock.currentTimeMillis;
      // Every object listed from here on is moved by this pass.
      const listedAt = Math.floor(started / 1000);
      const target = `move-${listedAt}`;
      const timeout = (news.timeoutSeconds ?? 1800) * 1000;
      const attrs = { accountId, workflowName };

      // The old classes the upload kept, and their objects that may hold data.
      const live = news.classes.filter(({ className }) => news.namespaces[className] !== undefined);
      const pages: Array<{ n: number; className: string; route: string; ids: string[] }> = [];
      for (const { className, route } of live) {
        const objects = yield* durableObjects.listNamespaceObjects
          .items({ accountId, id: news.namespaces[className]! })
          .pipe(
            Stream.filter((object) => object.hasStoredData === true),
            Stream.runCollect,
            // The upload deleted the class: nothing of it is left to move.
            Effect.catchTag("NamespaceNotFound", () => Effect.succeed([])),
          );
        const ids = Array.from(objects, (object) => object.id).filter(
          (id): id is string => typeof id === "string",
        );
        for (let i = 0; i < ids.length; i += PAGE)
          pages.push({ n: pages.length, className, route, ids: ids.slice(i, i + PAGE) });
      }
      const total = pages.reduce((sum, page) => sum + page.ids.length, 0);

      /** Start instances, a hundred per call; one started before is found started. */
      const create = (instances: ReadonlyArray<{ readonly id: string; readonly params: object }>) =>
        Effect.forEach(
          Array.from({ length: Math.ceil(instances.length / BULK) }, (_, i) =>
            instances.slice(i * BULK, (i + 1) * BULK),
          ),
          (group) =>
            workflows
              .bulkInstance({
                accountId,
                workflowName,
                body: group.map(({ id, params }) => ({ instanceId: id, params })),
              })
              .pipe(
                Effect.asVoid,
                // A deploy started again: one by one, skipping those that exist.
                Effect.catchTag("InstanceAlreadyExists", () =>
                  Effect.forEach(
                    group,
                    ({ id, params }) =>
                      workflows
                        .createInstance({ accountId, workflowName, instanceId: id, params })
                        .pipe(
                          Effect.asVoid,
                          Effect.catchTag("InstanceAlreadyExists", () => Effect.void),
                        ),
                    { discard: true },
                  ),
                ),
                // The Workflow is uploaded with the Worker: it can take a moment to appear.
                Effect.retry({
                  while: (error) =>
                    error._tag === "WorkflowNotFound" ||
                    error._tag === "WorkflowInternalError" ||
                    error._tag === "CloudflareRateLimited",
                  schedule: Schedule.spaced("2 seconds"),
                  times: 30,
                }),
              ),
          { discard: true },
        );
      const instance = (instanceId: string) =>
        workflows
          .getInstance({ accountId, workflowName, instanceId })
          .pipe(Effect.retry(retryInternal));
      const ended = (instanceId: string, status: string, error: string | undefined) =>
        new MigrationFailed({
          message: `Moving Domain objects to the shared class ended ${status}: ${error ?? "no error reported"}. Deploy again to move the rest; nothing that moved is lost.`,
          instanceId,
        });
      /**
       * Record each class's complete pass as an instance of the Workflow that
       * does nothing: the Worker's next upload reads them, and deletes a class
       * once two passes far enough apart have seen every object written
       * before the move. A class with objects that couldn't move gets none.
       */
      const mark = (skipped: Readonly<Record<string, number>>) =>
        create(
          live
            .filter(({ className }) => (skipped[className] ?? 0) === 0)
            .map(({ className }) => ({
              id: passMarker(className, news.namespaces[className]!, listedAt),
              params: { op: "mark" },
            })),
        );

      if (total === 0) {
        yield* mark({});
        return { ...attrs, instances: 0, moved: 0 };
      }
      yield* session.note(
        `Moving ${total} Domain objects of ${live.length} classes to the shared class ...`,
        { kind: "status" },
      );

      // Hand the run its pages, a few per instance (an instance's params are limited).
      const adds = Array.from({ length: Math.ceil(pages.length / PAGES_PER_ADD) }, (_, i) => ({
        id: `mg-add-${target}-${i}`,
        params: {
          op: "add",
          target,
          pages: pages.slice(i * PAGES_PER_ADD, (i + 1) * PAGES_PER_ADD),
        },
      }));
      yield* create(adds);
      for (const add of adds) {
        for (let attempt = 0, id = add.id; ; attempt++) {
          const done = yield* instance(id).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (status) => status.status !== "queued" && status.status !== "running",
              times: 120,
            }),
          );
          if (done.status === "complete") break;
          // Started on an edge that doesn't have the uploaded Worker yet, or reached an
          // object still on the code before it: start it again.
          const elapsed = (yield* Clock.currentTimeMillis) - started;
          if (worthRestarting(done.error?.message ?? "", elapsed) && attempt < MAX_RESTARTS) {
            yield* Effect.sleep(RESTART_DELAY);
            id = `${add.id}-${attempt + 1}`;
            yield* create([{ id, params: add.params }]);
            continue;
          }
          return yield* ended(id, done.status, done.error?.message ?? undefined);
        }
      }

      // Start the run and wait for it: each check step's output is its progress.
      const runParams = {
        op: "run",
        target,
        plan: {
          pages: pages.map(({ n, className, ids }) => ({ n, className, size: ids.length })),
        },
      };
      let runId = `mg-run-${target}`;
      let restarts = 0;
      yield* create([{ id: runId, params: runParams }]);
      let progress: (Progress & { readonly skipped?: Record<string, number> }) | undefined;
      while (true) {
        const status = yield* instance(runId);
        const latest = progressOf(status.steps ?? [])?.[0];
        if (latest !== undefined) progress = latest as typeof progress;
        if (status.status === "complete") break;
        if (status.status === "errored" || status.status === "terminated") {
          // Started on an edge that doesn't have the uploaded Worker yet, or reached an
          // object still on the code before it: start it again. The run itself is in
          // Durable Objects: a new instance waits on the same run.
          const elapsed = (yield* Clock.currentTimeMillis) - started;
          if (worthRestarting(status.error?.message ?? "", elapsed) && restarts < MAX_RESTARTS) {
            restarts += 1;
            yield* Effect.sleep(RESTART_DELAY);
            runId = `mg-run-${target}-${restarts}`;
            yield* create([{ id: runId, params: runParams }]);
            continue;
          }
          return yield* ended(runId, status.status, status.error?.message ?? undefined);
        }
        const elapsed = (yield* Clock.currentTimeMillis) - started;
        const where =
          progress === undefined
            ? "starting"
            : `${progress.instances}/${total} moved (${progress.done}/${progress.subtrees} pages${progress.refused > 0 ? `, ${progress.refused} calls refused` : ""})`;
        if (elapsed > timeout)
          return yield* new MigrationStillRunning({
            message: `Moving Domain objects to the shared class is still running after ${Math.round(elapsed / 1000)}s: ${where}. It keeps running on Cloudflare; the next deploy waits on it again.`,
          });
        yield* session.note(
          `Moving Domain objects to the shared class: ${where} (${Math.round(elapsed / 1000)}s) ...`,
          { kind: "status" },
        );
        yield* Effect.sleep(POLL);
      }

      const skipped = progress?.skipped ?? {};
      for (const [className, count] of Object.entries(skipped))
        yield* session.note(
          `${count} objects of ${className} know neither their name nor their key, so they can't move to the shared class: the class is kept.`,
          { kind: "status" },
        );
      yield* mark(skipped);
      yield* session.note(`Moved ${total} Domain objects to the shared class`, { kind: "status" });
      return { ...attrs, instances: adds.length + 1, moved: total };
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
      return { accountId: "dev", workflowName: news.workflowName, instances: 0, moved: 0 };
    }),
    delete: Effect.fn(function* () {}),
  });

export const MigrationProvider = () =>
  ProviderLayer.dual(Migration, {
    local: () => MigrationLocal(),
    live: () => MigrationLive(),
  });
