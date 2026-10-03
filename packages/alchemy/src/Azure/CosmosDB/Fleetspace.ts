import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isOwnedChild } from "./Shared.ts";

export interface FleetspaceThroughputPool {
  /**
   * Minimum RU/s of the pool, billed even when idle. At least 100,000 and a
   * multiple of 1,000.
   */
  minThroughput: number;
  /**
   * Maximum RU/s the pool autoscales to. At least `minThroughput`, at most
   * 10x it, and a multiple of 1,000.
   */
  maxThroughput: number;
}

export interface FleetspaceProps {
  /** Resource group of the fleet. Changing it replaces the fleetspace. */
  resourceGroup: string;
  /** Name of the parent fleet, e.g. `fleet.fleetName`. Changing it replaces the fleetspace. */
  fleet: string;
  /**
   * Fleetspace name: lowercase letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the fleetspace.
   */
  name?: string;
  /**
   * API of the accounts in the fleetspace.
   * @default "NoSQL"
   */
  apiKind?: "NoSQL";
  /**
   * Write-region type every account must use: `GeneralPurpose` (single
   * write region) or `BusinessCritical` (multi-region writes). Changing it
   * replaces the fleetspace.
   * @default "GeneralPurpose"
   */
  serviceTier?: "GeneralPurpose" | "BusinessCritical";
  /**
   * Regions every account must be in, e.g. `["westus2"]`. Changing them
   * replaces the fleetspace.
   * @default [the provider's default location]
   */
  dataRegions?: string[];
  /**
   * Shared throughput pool the accounts can burst into on top of their own
   * dedicated RU/s. Omit for a fleetspace without pooling (free). The
   * minimum and maximum can be changed in place; adding or removing the
   * pool replaces the fleetspace.
   */
  throughputPool?: FleetspaceThroughputPool;
}

export interface Fleetspace extends Resource<
  "Azure.CosmosDB.Fleetspace",
  FleetspaceProps,
  {
    /** Name of the fleetspace. */
    fleetspaceName: string;
    /** Name of the parent fleet. */
    fleet: string;
    /** Resource group of the fleet. */
    resourceGroup: string;
    /** ARM resource ID of the fleetspace. */
    fleetspaceId: string;
    /** Write-region type of the pool, when set. */
    serviceTier: string | undefined;
    /** Regions of the pool, when set. */
    dataRegions: string[];
    /** Observed throughput pool, when configured. */
    throughputPool: FleetspaceThroughputPool | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A fleetspace inside an Azure Cosmos DB {@link Fleet}: a group of database
 * accounts that can share a throughput pool. Every account in a fleet
 * belongs to exactly one fleetspace.
 *
 * A fleetspace without a pool is free. A pool bills its `minThroughput`
 * (at least 100,000 RU/s) every hour, even when idle.
 *
 * Fleetspaces cannot be tagged; Alchemy treats one it created (or one under
 * a generated name) as its own.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/fleet-pools
 *
 * ### Creating a Fleetspace
 * **Example:** Fleetspace without pooling
 * ```typescript
 * const fleet = yield* Azure.CosmosDB.Fleet("tenants", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const space = yield* Azure.CosmosDB.Fleetspace("standard", {
 *   resourceGroup: group.resourceGroupName,
 *   fleet: fleet.fleetName,
 * });
 * ```
 *
 * ### Throughput Pooling
 * **Example:** Pool shared by single-write accounts in one region
 * ```typescript
 * const space = yield* Azure.CosmosDB.Fleetspace("pooled", {
 *   resourceGroup: group.resourceGroupName,
 *   fleet: fleet.fleetName,
 *   serviceTier: "GeneralPurpose",
 *   dataRegions: ["westus2"],
 *   throughputPool: { minThroughput: 100_000, maxThroughput: 200_000 },
 * });
 * ```
 *
 * @resource
 */
export const Fleetspace = Resource<Fleetspace>("Azure.CosmosDB.Fleetspace");

const normalizeRegion = (region: string) =>
  region.toLowerCase().replace(/\s+/g, "");

const regionsKey = (regions: readonly string[] | undefined) =>
  [...(regions ?? [])].map(normalizeRegion).sort().join(",");

const createFleetspaceName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 50,
    lowercase: true,
  });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

const getFleetspace = (
  subscriptionId: string,
  resourceGroupName: string,
  fleetName: string,
  fleetspaceName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetFleetspace({
      subscriptionId,
      resourceGroupName,
      fleetName,
      fleetspaceName,
    }),
  );

type ObservedFleetspace = cosmos.GetFleetspaceResponse;

/** Fleetspaces report `Online` or `Succeeded` once usable. */
const stateOf = (space: ObservedFleetspace) => {
  const state = space.properties?.provisioningState;
  return state === "Online" ? "Succeeded" : state;
};

const observedPool = (
  space: ObservedFleetspace,
): FleetspaceThroughputPool | undefined => {
  const pool = space.properties?.throughputPoolConfiguration;
  return pool?.minThroughput !== undefined &&
    pool.maxThroughput !== undefined
    ? { minThroughput: pool.minThroughput, maxThroughput: pool.maxThroughput }
    : undefined;
};

const poolMatches = (
  space: ObservedFleetspace,
  desired: FleetspaceThroughputPool | undefined,
) => {
  const pool = observedPool(space);
  return desired === undefined
    ? true
    : pool?.minThroughput === desired.minThroughput &&
        pool.maxThroughput === desired.maxThroughput;
};

const toAttrs = (
  resourceGroup: string,
  fleet: string,
  name: string,
  space: ObservedFleetspace,
): Fleetspace["Attributes"] => ({
  fleetspaceName: name,
  fleet,
  resourceGroup,
  fleetspaceId: space.id ?? "",
  serviceTier: space.properties?.serviceTier,
  dataRegions: [...(space.properties?.dataRegions ?? [])],
  throughputPool: observedPool(space),
  provisioningState: space.properties?.provisioningState,
});

export const FleetspaceProvider = () =>
  Provider.succeed(Fleetspace, {
    stables: ["fleetspaceName", "fleet", "resourceGroup", "fleetspaceId"],

    // Fleetspaces disappear with their fleet.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.fleet !== output.fleet ||
        (news.name !== undefined && news.name !== output.fleetspaceName) ||
        (news.serviceTier !== undefined &&
          news.serviceTier !== output.serviceTier) ||
        (news.dataRegions !== undefined &&
          regionsKey(news.dataRegions) !== regionsKey(output.dataRegions)) ||
        (news.throughputPool === undefined) !==
          (output.throughputPool === undefined)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const fleet = output?.fleet ?? olds?.fleet;
      if (resourceGroup === undefined || fleet === undefined) return undefined;
      const name =
        output?.fleetspaceName ??
        olds?.name ??
        (yield* createFleetspaceName(id));
      const observed = yield* getFleetspace(
        subscriptionId,
        resourceGroup,
        fleet,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, fleet, name, observed);
      return isOwnedChild(output, olds?.name) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId, location } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DocumentDB");
      const { resourceGroup, fleet } = news;
      const name =
        news.name ??
        output?.fleetspaceName ??
        (yield* createFleetspaceName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        fleetName: fleet,
        fleetspaceName: name,
      };
      const label = `Cosmos DB fleetspace ${name}`;
      const get = getFleetspace(subscriptionId, resourceGroup, fleet, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* cosmos.CreateFleetspace({
          ...where,
          properties: {
            fleetspaceApiKind: news.apiKind ?? "NoSQL",
            serviceTier: news.serviceTier ?? "GeneralPurpose",
            dataRegions: (news.dataRegions ?? [location]).map(normalizeRegion),
            throughputPoolConfiguration: news.throughputPool,
          },
        });
      }
      observed = yield* waitForProvisioned(label, get, stateOf, {
        interval: "5 seconds",
        times: 60,
      });

      // Sync the pool bounds against the observed pool.
      if (!poolMatches(observed, news.throughputPool)) {
        yield* cosmos.UpdateFleetspace({
          ...where,
          properties: { throughputPoolConfiguration: news.throughputPool },
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (space) =>
            poolMatches(space, news.throughputPool)
              ? stateOf(space)
              : "Updating",
          { interval: "5 seconds", times: 60 },
        );
      }

      return toAttrs(resourceGroup, fleet, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cosmos.DeleteFleetspace({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          fleetName: output.fleet,
          fleetspaceName: output.fleetspaceName,
        }),
      );
      yield* waitUntilGone(
        `Cosmos DB fleetspace ${output.fleetspaceName}`,
        getFleetspace(
          subscriptionId,
          output.resourceGroup,
          output.fleet,
          output.fleetspaceName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.CosmosDB.Fleet", "Azure.Resources.ResourceGroup"],
    },
  });
