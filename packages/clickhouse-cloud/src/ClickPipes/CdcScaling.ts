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

export interface CdcScalingProps {
  /** ID of the service whose database ClickPipes share the infrastructure. Changing it replaces the resource. */
  serviceId: string;
  /** CPU of the CDC infrastructure in millicores (2000 per compute unit). */
  replicaCpuMillicores: number;
  /** Memory in GiB: four times the CPU cores (8 per compute unit). */
  replicaMemoryGb: number;
}

export interface CdcScalingAttributes {
  /** Service ID. */
  serviceId: string;
  /** Organization ID. */
  organizationId: string;
  /** CPU in millicores. */
  replicaCpuMillicores: number | undefined;
  /** Memory in GiB. */
  replicaMemoryGb: number | undefined;
  /** The sizing before alchemy first changed it; restored on destroy. */
  baseline: { replicaCpuMillicores: number | undefined; replicaMemoryGb: number | undefined };
}

export type CdcScaling = Resource<
  "ClickHouseCloud.ClickPipes.CdcScaling",
  CdcScalingProps,
  CdcScalingAttributes,
  never,
  Providers
>;

/**
 * The size of the infrastructure every database ClickPipe (Postgres, MySQL,
 * MongoDB CDC) of a service shares: CPU and memory, where 2 cores and 8 GB
 * are one compute unit.
 *
 * The infrastructure exists once the service has a database ClickPipe:
 * before that, deploy fails with `FeatureUnavailable`, so depend on the
 * pipe. The first deploy records the sizing, and destroy puts it back.
 * Changes take a few minutes to propagate; deploy waits until ClickHouse
 * reports the new sizing.
 * @see https://clickhouse.com/docs/integrations/clickpipes/postgres/scaling
 *
 * ### Sizing CDC
 * **Example:** Two compute units for a busy Postgres pipe
 * ```typescript
 * const cdc = yield* ClickHouseCloud.ClickPipes.ClickPipe("Orders", {
 *   serviceId: analytics.serviceId,
 *   source: { postgres: { host: "db.example.com", port: 5432, database: "app" } },
 *   destination: { database: "default" },
 * });
 * yield* ClickHouseCloud.ClickPipes.CdcScaling("CdcSize", {
 *   serviceId: cdc.serviceId,
 *   replicaCpuMillicores: 4000,
 *   replicaMemoryGb: 16,
 * });
 * ```
 *
 * @resource
 * @product ClickPipes
 */
export const CdcScaling = Resource<CdcScaling>("ClickHouseCloud.ClickPipes.CdcScaling");

const getScaling = (organizationId: string, serviceId: string) =>
  pipes.getClickPipeCdcScaling({ organizationId, serviceId }).pipe(
    Effect.flatMap(requireResult("getClickPipeCdcScaling")),
    // No CDC infrastructure yet, or no service.
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const CdcScalingProvider = () =>
  Provider.effect(
    CdcScaling,
    Effect.succeed({
      stables: ["serviceId", "organizationId", "baseline"],
      nuke: { singleton: true, dependsOn: ["ClickHouseCloud.Service.Service"] },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (news.serviceId !== olds.serviceId) return { action: "replace" } as const;
        return undefined;
      }),
      read: Effect.fn(function* ({ olds, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const serviceId = output?.serviceId ?? olds.serviceId;
        const scaling = yield* getScaling(organizationId, serviceId);
        if (scaling === undefined) return undefined;
        return {
          serviceId,
          organizationId,
          replicaCpuMillicores: scaling.replicaCpuMillicores,
          replicaMemoryGb: scaling.replicaMemoryGb,
          baseline: output?.baseline ?? {
            replicaCpuMillicores: scaling.replicaCpuMillicores,
            replicaMemoryGb: scaling.replicaMemoryGb,
          },
        };
      }),
      reconcile: Effect.fn(function* ({ news, output, session }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { serviceId } = news;
        // Observe
        const observed = yield* getScaling(organizationId, serviceId);
        if (observed === undefined) {
          return yield* new FeatureUnavailable({
            feature: "CDC scaling",
            reason: "the service has no database ClickPipe yet; create one first and depend on it",
          });
        }
        const baseline = output?.baseline ?? {
          replicaCpuMillicores: observed.replicaCpuMillicores,
          replicaMemoryGb: observed.replicaMemoryGb,
        };
        const done = (s: pipes.ClickPipesCdcScaling | undefined): s is pipes.ClickPipesCdcScaling =>
          s?.replicaCpuMillicores === news.replicaCpuMillicores &&
          s?.replicaMemoryGb === news.replicaMemoryGb;
        // Sync, then wait for the change to propagate.
        let current = observed;
        if (!done(observed)) {
          yield* pipes.updateClickPipeCdcScaling({
            organizationId,
            serviceId,
            replicaCpuMillicores: news.replicaCpuMillicores,
            replicaMemoryGb: news.replicaMemoryGb,
          });
          current = yield* pollUntil({
            kind: "CDC scaling",
            id: serviceId,
            waitingFor: "applied",
            read: getScaling(organizationId, serviceId),
            state: (s) => (s ? `${s.replicaCpuMillicores}m/${s.replicaMemoryGb}GiB` : undefined),
            done,
            session,
            budget: Duration.minutes(15),
          });
        }
        return {
          serviceId,
          organizationId,
          replicaCpuMillicores: current.replicaCpuMillicores,
          replicaMemoryGb: current.replicaMemoryGb,
          baseline,
        };
      }),
      delete: Effect.fn(function* ({ output }) {
        const { organizationId, serviceId, baseline } = output;
        if (baseline.replicaCpuMillicores === undefined || baseline.replicaMemoryGb === undefined)
          return;
        const observed = yield* getScaling(organizationId, serviceId);
        if (observed === undefined) return;
        yield* pipes
          .updateClickPipeCdcScaling({ organizationId, serviceId, ...baseline })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    }),
  );
