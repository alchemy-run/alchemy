import * as workflows from "@distilled.cloud/cloudflare/workflows";
import { isResolved } from "alchemy/Diff";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";

export interface BackfillProps {
  /** The Domain's Worker: a run starts once the Worker carrying its Workflow is deployed. */
  scriptName: string;
  /** The Workflow, hosted by the Domain's Worker, that runs a backfill and waits for it. */
  workflowName: string;
  /**
   * Every view and projection in the model, by target id (`view:Name`, with
   * `#<generation>` once rebuilt). Those new to the Domain are backfilled.
   */
  targets: string[];
  /**
   * What the backfill needs to know of each consumer (the sources it reads, and
   * whether a key reads its one source's log itself), by target id. The run
   * announces them, so it doesn't depend on what an isolate has loaded.
   */
  plans?: Record<string, { sources?: string[]; singleSource: boolean }>;
  /**
   * How long a deploy waits for the backfill, in seconds. Past it the deploy
   * fails while the backfill keeps running in Cloudflare; the next deploy waits
   * on the same run.
   * @default 1800
   */
  timeoutSeconds?: number;
}

export interface BackfillAttrs {
  accountId: string;
  workflowName: string;
  /** The run: named after the targets, so a deploy with the same model finds it again. */
  instanceId: string;
  targets: string[];
  status: string;
}

const BackfillTypeId = "Cloudflare.Domain.Backfill";

/**
 * The backfill of a Domain's views and projections, run by reconciliation.
 * The Durable Object platform declares it with the model's consumers: on each
 * deploy that adds a view or projection (or bumps a version), it starts a run
 * of the Domain's backfill Workflow, and waits until every new consumer has
 * received the history recorded before it. You don't declare it yourself.
 *
 * @resource
 * @product Durable Objects
 */
export interface Backfill extends Resource<typeof BackfillTypeId, BackfillProps, BackfillAttrs> {}

export const Backfill = Resource<Backfill>(BackfillTypeId);

/** The backfill run still going when the deploy stopped waiting. */
export class BackfillStillRunning extends Data.TaggedError("BackfillStillRunning")<{
  readonly message: string;
  readonly instanceId: string;
}> {}

/** The backfill run ended without completing. */
export class BackfillFailed extends Data.TaggedError("BackfillFailed")<{
  readonly message: string;
  readonly instanceId: string;
  readonly status: string;
}> {}

/**
 * A run id from the targets and this resource's own instance: a deploy of the
 * same model finds the same run, and a stack destroyed and deployed again starts
 * a new one (Cloudflare keeps finished instance ids). FNV-1a over the sorted ids.
 */
const runIdOf = (targets: ReadonlyArray<string>, resource: string) => {
  let hash = 0x811c9dc5;
  for (const char of [...targets].sort().join("|")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `backfill-${resource.slice(0, 12)}-${hash.toString(16).padStart(8, "0")}-${targets.length}`;
};

const POLL = "1 second";
/** How many times a run that started before the new version arrived is run again, and how soon. */
const MAX_RESTARTS = 10;
const RESTART_DELAY = "2 seconds";

/**
 * Workflows answers instance calls for a Workflow uploaded moments before with
 * an internal error (code 10001) for a while: call again.
 */
const retryInternal = {
  while: (error: { readonly _tag: string }) => error._tag === "WorkflowInternalError",
  schedule: Schedule.spaced("2 seconds"),
  times: 30,
};

const BackfillLive = () =>
  Provider.succeed(Backfill, {
    stables: ["accountId", "workflowName"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return { action: "update" } as const;
      const changed =
        olds.workflowName !== news.workflowName ||
        [...olds.targets].sort().join("|") !== [...(news.targets ?? [])].sort().join("|");
      if (changed) return { action: "update" } as const;
    }),
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const instance = yield* workflows
        .getInstance({
          accountId: output.accountId,
          workflowName: output.workflowName,
          instanceId: output.instanceId,
          simple: true,
        })
        .pipe(
          Effect.catchTag(["InstanceNotFound", "WorkflowNotFound"], () =>
            Effect.succeed(undefined),
          ),
        );
      return instance === undefined ? undefined : { ...output, status: instance.status };
    }),
    reconcile: Effect.fn(function* ({ instanceId: resource, news, session }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const instanceId = runIdOf(news.targets, resource);
      const attrs = {
        accountId,
        workflowName: news.workflowName,
        instanceId,
        targets: news.targets,
      };
      // Start the run, or find the one an earlier deploy started.
      yield* workflows
        .createInstance({
          accountId,
          workflowName: news.workflowName,
          instanceId,
          params: { targets: news.targets, plans: news.plans ?? {} },
        })
        .pipe(
          Effect.asVoid,
          Effect.catchTag("InstanceAlreadyExists", () => Effect.void),
          // The Workflow was just uploaded with the Worker: it can take a moment to appear.
          Effect.retry({
            while: (error) =>
              error._tag === "WorkflowNotFound" || error._tag === "WorkflowInternalError",
            schedule: Schedule.spaced("2 seconds"),
            times: 30,
          }),
        );
      const started = yield* Effect.sync(() => Date.now());
      let restarts = 0;
      const timeout = (news.timeoutSeconds ?? 1800) * 1000;
      while (true) {
        const instance = yield* workflows
          .getInstance({
            accountId,
            workflowName: news.workflowName,
            instanceId,
            simple: true,
          })
          .pipe(Effect.retry(retryInternal));
        if (instance.status === "complete") return { ...attrs, status: "complete" };
        if (instance.status === "errored" || instance.status === "terminated") {
          const { error } = yield* workflows
            .getInstance({
              accountId,
              workflowName: news.workflowName,
              instanceId,
            })
            .pipe(Effect.retry(retryInternal));
          // Started on an edge that doesn't have the uploaded Worker (or its entrypoint) yet: run it again
          // once the new version has arrived.
          if (
            instance.status === "errored" &&
            /entrypoint name .* was not found|^Worker not found/.test(error?.message ?? "") &&
            restarts < MAX_RESTARTS
          ) {
            restarts += 1;
            yield* Effect.sleep(RESTART_DELAY);
            yield* workflows
              .patchInstanceStatus({
                accountId,
                workflowName: news.workflowName,
                instanceId,
                status: "restart",
              })
              .pipe(Effect.retry(retryInternal));
            continue;
          }
          return yield* new BackfillFailed({
            message: `The backfill run ${instanceId} ended ${instance.status}${error?.message ? `: ${error.name}: ${error.message}` : ""}`,
            instanceId,
            status: instance.status,
          });
        }
        const elapsed = (yield* Effect.sync(() => Date.now())) - started;
        if (elapsed > timeout) {
          return yield* new BackfillStillRunning({
            message: `The backfill of ${news.targets.join(", ")} is still running after ${Math.round(elapsed / 1000)}s. It keeps running in Cloudflare; the next deploy waits on it again.`,
            instanceId,
          });
        }
        yield* session.note(
          `Backfilling ${news.targets.join(", ")} (${Math.round(elapsed / 1000)}s) ...`,
          { kind: "status" },
        );
        yield* Effect.sleep(POLL);
      }
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* workflows
        .patchInstanceStatus({
          accountId: output.accountId,
          workflowName: output.workflowName,
          instanceId: output.instanceId,
          status: "terminate",
        })
        .pipe(
          Effect.asVoid,
          Effect.catchTag(
            ["InstanceNotFound", "WorkflowNotFound", "InstanceCannotTerminate"],
            () => Effect.void,
          ),
        );
    }),
  });

/** In `alchemy dev` the Domain backfills itself on its first call: nothing to wait for. */
const BackfillLocal = () =>
  Provider.succeed(Backfill, {
    diff: Effect.fn(function* () {
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      return output;
    }),
    reconcile: Effect.fn(function* ({ instanceId, news }) {
      return {
        accountId: "dev",
        workflowName: news.workflowName,
        instanceId: `dev:${runIdOf(news.targets, instanceId)}`,
        targets: news.targets,
        status: "complete",
      };
    }),
    delete: Effect.fn(function* () {}),
  });

export const BackfillProvider = () =>
  ProviderLayer.dual(Backfill, {
    local: () => BackfillLocal(),
    live: () => BackfillLive(),
  });
