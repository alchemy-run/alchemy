import * as amp from "@distilled.cloud/aws/amp";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { syncAmpTags, toTagRecord } from "./internal.ts";

export interface WorkspaceProps {
  /**
   * A human-readable alias for the workspace. Aliases are not unique — many
   * workspaces can share one. Updating the alias is an in-place update.
   */
  alias?: string;
  /**
   * ARN of a customer-managed KMS key used to encrypt data at rest. If
   * omitted, an AWS-owned key is used. Changing the key replaces the
   * workspace (encryption configuration is immutable).
   */
  kmsKeyArn?: string;
  /**
   * User-defined tags for the workspace.
   */
  tags?: Record<string, string>;
}

export interface Workspace extends Resource<
  "AWS.AMP.Workspace",
  WorkspaceProps,
  {
    workspaceId: string;
    workspaceArn: string;
    prometheusEndpoint: string | undefined;
    alias: string | undefined;
    status: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Managed Service for Prometheus (AMP) workspace — a logical,
 * fully-managed Prometheus-compatible metrics store. Metrics are ingested
 * via remote-write and queried through the workspace's Prometheus-compatible
 * endpoint.
 *
 * @resource
 * @section Creating a Workspace
 * @example Basic Workspace
 * ```typescript
 * const workspace = yield* AMP.Workspace("Metrics", {
 *   alias: "production-metrics",
 * });
 * ```
 *
 * @example Workspace with Customer-Managed Encryption
 * ```typescript
 * const workspace = yield* AMP.Workspace("Metrics", {
 *   alias: "production-metrics",
 *   kmsKeyArn: key.keyArn,
 *   tags: { team: "observability" },
 * });
 * ```
 *
 * @section Using the Endpoint
 * @example Read the Remote-Write URL
 * ```typescript
 * // prometheusEndpoint ends in a trailing slash; append `api/v1/remote_write`
 * const remoteWrite = `${workspace.prometheusEndpoint}api/v1/remote_write`;
 * ```
 */
export const Workspace = Resource<Workspace>("AWS.AMP.Workspace");

export const WorkspaceProvider = () =>
  Provider.effect(
    Workspace,
    Effect.gen(function* () {
      const toAttrs = (workspace: amp.WorkspaceDescription) => ({
        workspaceId: workspace.workspaceId,
        workspaceArn: workspace.arn,
        prometheusEndpoint: workspace.prometheusEndpoint,
        alias: workspace.alias,
        status: workspace.status.statusCode,
      });

      /** Describe a workspace by id; typed not-found → undefined. */
      const describe = Effect.fn(function* (workspaceId: string) {
        const response = yield* amp
          .describeWorkspace({ workspaceId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.workspace;
      });

      /**
       * Poll until the workspace leaves CREATING/UPDATING and reaches
       * ACTIVE. Fails fast on a *_FAILED terminal status.
       */
      const waitActive = Effect.fn(function* (workspaceId: string) {
        const workspace = yield* amp.describeWorkspace({ workspaceId }).pipe(
          Effect.map((r) => r.workspace),
          Effect.repeat({
            schedule: Schedule.fixed("2 seconds").pipe(
              Schedule.both(Schedule.recurs(30)),
            ),
            until: (w) => w.status.statusCode === "ACTIVE",
          }),
        );
        if (workspace.status.statusCode !== "ACTIVE") {
          return yield* Effect.fail(
            new Error(
              `AMP workspace ${workspaceId} did not become ACTIVE (status: ${workspace.status.statusCode})`,
            ),
          );
        }
        return workspace;
      });

      return {
        stables: ["workspaceId", "workspaceArn", "prometheusEndpoint"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          // Encryption configuration is immutable — a change replaces.
          if (
            (olds?.kmsKeyArn ?? undefined) !== (news?.kmsKeyArn ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, output }) {
          // Workspace ids are server-assigned; without an output cache there
          // is no deterministic identity to look up.
          if (!output?.workspaceId) return undefined;
          const workspace = yield* describe(output.workspaceId);
          if (workspace === undefined) return undefined;
          const attrs = toAttrs(workspace);
          const tags = toTagRecord(workspace.tags);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative; output is an id cache.
          let workspace =
            output?.workspaceId !== undefined
              ? yield* describe(output.workspaceId)
              : undefined;

          // 2. Ensure — create if missing, then wait for ACTIVE.
          if (workspace === undefined) {
            const created = yield* amp.createWorkspace({
              alias: news.alias,
              kmsKeyArn: news.kmsKeyArn,
              tags: desiredTags,
            });
            workspace = yield* waitActive(created.workspaceId);
          }

          const workspaceId = workspace.workspaceId;

          // 3. Sync alias — in-place update when it drifts.
          if ((news.alias ?? undefined) !== (workspace.alias ?? undefined)) {
            yield* amp.updateWorkspaceAlias({
              workspaceId,
              alias: news.alias,
            });
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncAmpTags(workspace.arn, desiredTags);

          // 4. Re-read for fresh attributes (alias/status may have changed).
          const fresh = (yield* describe(workspaceId)) ?? workspace;
          yield* session.note(workspaceId);
          return toAttrs(fresh);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* amp.deleteWorkspace({ workspaceId: output.workspaceId }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            // A workspace mid-transition rejects deletion; retry briefly.
            Effect.retry({
              while: (e) => e._tag === "ConflictException",
              schedule: Schedule.fixed("3 seconds").pipe(
                Schedule.both(Schedule.recurs(20)),
              ),
            }),
          );
        }),

        list: () =>
          amp.listWorkspaces.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.workspaces),
            ),
            Effect.flatMap(
              Effect.forEach(
                (summary) =>
                  describe(summary.workspaceId).pipe(
                    Effect.map((w) => (w ? toAttrs(w) : undefined)),
                  ),
                { concurrency: 4 },
              ),
            ),
            Effect.map((items) => items.filter((item) => item !== undefined)),
          ),
      };
    }),
  );
