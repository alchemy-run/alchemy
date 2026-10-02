import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface FleetProps {
  /** Resource group the fleet is created in. Changing it replaces the fleet. */
  resourceGroup: string;
  /**
   * Fleet name: 3-44 lowercase letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the fleet.
   */
  name?: string;
  /**
   * Azure region of the fleet resource. It does not constrain the regions
   * of the accounts in the fleet. Changing it replaces the fleet.
   * @default the provider's default location
   */
  location?: string;
  /** Tags applied to the fleet. */
  tags?: Record<string, string>;
}

export interface Fleet extends Resource<
  "Azure.CosmosDB.Fleet",
  FleetProps,
  {
    /** Name of the fleet. */
    fleetName: string;
    /** ARM resource ID of the fleet. */
    fleetId: string;
    /** Resource group that holds the fleet. */
    resourceGroup: string;
    /** Location of the fleet (lowercase, no spaces, e.g. `eastus`). */
    location: string;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Cosmos DB fleet: the top-level grouping of the database accounts
 * that serve one multi-tenant application. Accounts join a fleet through a
 * {@link Fleetspace}, which can optionally pool throughput across them.
 *
 * A fleet itself is free.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/fleet
 *
 * ### Creating a Fleet
 * **Example:** Fleet in the default location
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const fleet = yield* Azure.CosmosDB.Fleet("tenants", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Fleet with tags
 * ```typescript
 * const fleet = yield* Azure.CosmosDB.Fleet("tenants", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "westus2",
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * @resource
 */
export const Fleet = Resource<Fleet>("Azure.CosmosDB.Fleet");

const normalizeLocation = (location: string | undefined) =>
  (location ?? "").toLowerCase().replace(/\s+/g, "");

const createFleetName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 44,
    lowercase: true,
  });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

const getFleet = (
  subscriptionId: string,
  resourceGroupName: string,
  fleetName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetFleet({ subscriptionId, resourceGroupName, fleetName }),
  );

/** Fleets report `Online` or `Succeeded` once usable. */
const stateOf = (fleet: { properties?: { provisioningState?: string } }) => {
  const state = fleet.properties?.provisioningState;
  return state === "Online" ? "Succeeded" : state;
};

const toAttrs = (
  resourceGroup: string,
  name: string,
  fleet: cosmos.GetFleetResponse | cosmos.FleetResource,
): Fleet["Attributes"] => ({
  fleetName: name,
  fleetId: fleet.id ?? "",
  resourceGroup,
  location: normalizeLocation(fleet.location),
  provisioningState: fleet.properties?.provisioningState,
  tags: userTags(fleet.tags),
});

export const FleetProvider = () =>
  Provider.succeed(Fleet, {
    stables: ["fleetName", "fleetId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* cosmos
        .ListFleet({ subscriptionId })
        .pipe(Effect.flatMap((page) => requireSinglePage("ListFleet", page)));
      return (page.value ?? []).flatMap((fleet) => {
        const group = resourceGroupOf(fleet.id);
        return hasAnyAlchemyTag(fleet.tags) &&
          group !== undefined &&
          fleet.name !== undefined
          ? [toAttrs(group, fleet.name, fleet)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined && news.name !== output.fleetName) ||
        (news.location !== undefined &&
          normalizeLocation(news.location) !== output.location)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.fleetName ?? olds?.name ?? (yield* createFleetName(id));
      const observed = yield* getFleet(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DocumentDB");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.fleetName ?? (yield* createFleetName(id));
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.location,
      );
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        fleetName: name,
      };
      const label = `Cosmos DB fleet ${name}`;
      const get = getFleet(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* cosmos.CreateFleet({ ...where, location, tags, properties: {} });
      }
      observed = yield* waitForProvisioned(label, get, stateOf, {
        interval: "5 seconds",
        times: 60,
      });

      // Sync tags against observed tags.
      if (tagsDiffer(observed.tags, tags)) {
        yield* cosmos.UpdateFleet({ ...where, tags });
        observed = yield* waitForProvisioned(
          label,
          get,
          (fleet) =>
            tagsDiffer(fleet.tags, tags) ? "Updating" : stateOf(fleet),
          { interval: "5 seconds", times: 60 },
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cosmos.DeleteFleet({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          fleetName: output.fleetName,
        }),
      );
      yield* waitUntilGone(
        `Cosmos DB fleet ${output.fleetName}`,
        getFleet(subscriptionId, output.resourceGroup, output.fleetName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
