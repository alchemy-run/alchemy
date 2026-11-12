import * as pipes from "@distilled.cloud/clickhouse-cloud/click_pipes";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { FeatureUnavailable, requireResult } from "../Errors.ts";
import { pollUntil } from "../internal/Wait.ts";
import type { Providers } from "../Providers.ts";

export interface WorkloadIdentityProps {
  /** ID of the service whose ClickPipes read GCP sources. Changing it replaces the resource. */
  serviceId: string;
}

export interface WorkloadIdentityAttributes {
  /** Service ID. */
  serviceId: string;
  /** Organization ID. */
  organizationId: string;
  /** The GCP service account ClickPipes uses: grant it access to the source. */
  principal: string;
}

export type WorkloadIdentity = Resource<
  "ClickHouseCloud.ClickPipes.WorkloadIdentity",
  WorkloadIdentityProps,
  WorkloadIdentityAttributes,
  never,
  Providers
>;

/**
 * The GCP service account a service's ClickPipes authenticate as when a
 * source uses `SERVICE_ACCOUNT_WORKLOAD_IDENTITY` (Pub/Sub, GCS): read it
 * here to grant it access to the source *before* creating the pipe, since
 * creating a pipe checks that it can read.
 *
 * Nothing is created: deploy waits until the identity is ready and returns
 * its `principal`; destroy does nothing. Workload identity for ClickPipes
 * is in private preview: without it, deploy fails with
 * `FeatureUnavailable`.
 * @see https://clickhouse.com/docs/integrations/clickpipes
 *
 * ### Granting a GCP Source
 * **Example:** Let ClickPipes read a bucket
 * ```typescript
 * const identity = yield* ClickHouseCloud.ClickPipes.WorkloadIdentity("PipesIdentity", {
 *   serviceId: analytics.serviceId,
 * });
 * // grant `serviceAccount:${identity.principal}` roles/storage.objectViewer on the bucket
 * ```
 *
 * Uses ClickHouse Cloud API endpoints marked Beta: `getClickPipesServiceContext`.
 *
 * @resource
 * @product ClickPipes
 */
export const WorkloadIdentity = Resource<WorkloadIdentity>(
  "ClickHouseCloud.ClickPipes.WorkloadIdentity",
);

/** A context whose workload identity is ready, with its principal. */
interface ReadyContext extends pipes.ClickPipesServiceContext {
  gcpWorkloadIdentity: pipes.ClickPipesGcpWorkloadIdentityContext & { principal: string };
}

const getContext = (organizationId: string, serviceId: string) =>
  pipes
    .getClickPipesServiceContext({ organizationId, serviceId })
    .pipe(Effect.flatMap(requireResult("getClickPipesServiceContext")));

export const WorkloadIdentityProvider = () =>
  Provider.effect(
    WorkloadIdentity,
    Effect.succeed({
      stables: ["serviceId", "organizationId", "principal"],
      nuke: { singleton: true },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (news.serviceId !== olds.serviceId) return { action: "replace" } as const;
        return undefined;
      }),
      read: Effect.fn(function* ({ olds, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const serviceId = output?.serviceId ?? olds.serviceId;
        const identity = (yield* getContext(organizationId, serviceId).pipe(
          Effect.catchTag("NotFound", () => Effect.undefined),
        ))?.gcpWorkloadIdentity;
        if (!identity?.supported || !identity.principal) return undefined;
        return { serviceId, organizationId, principal: identity.principal };
      }),
      reconcile: Effect.fn(function* ({ news, output, session }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { serviceId } = news;
        const context = yield* getContext(organizationId, serviceId);
        if (!context.gcpWorkloadIdentity?.supported) {
          return yield* new FeatureUnavailable({
            feature: "ClickPipes GCP workload identity",
            reason:
              "the service reports `supported: false` (private preview: ask ClickHouse support)",
          });
        }
        const ready = yield* pollUntil({
          kind: "ClickPipes workload identity",
          id: serviceId,
          waitingFor: "ready",
          read: getContext(organizationId, serviceId),
          state: (c) => (c.gcpWorkloadIdentity?.ready ? "ready" : "not ready"),
          done: (c): c is ReadyContext =>
            c.gcpWorkloadIdentity?.ready === true &&
            typeof c.gcpWorkloadIdentity.principal === "string",
          session,
          budget: Duration.minutes(10),
        });
        return { serviceId, organizationId, principal: ready.gcpWorkloadIdentity.principal };
      }),
      delete: () => Effect.void,
    }),
  );
