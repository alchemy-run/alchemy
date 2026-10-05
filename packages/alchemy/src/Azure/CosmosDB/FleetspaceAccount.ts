import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
import { whileAccountBusy } from "./Shared.ts";

export interface FleetspaceAccountProps {
  /** Resource group of the fleet. Changing it replaces the membership. */
  resourceGroup: string;
  /** Name of the fleet, e.g. `fleet.fleetName`. Changing it replaces the membership. */
  fleet: string;
  /**
   * Name of the fleetspace, e.g. `space.fleetspaceName`. Changing it
   * replaces the membership.
   */
  fleetspace: string;
  /**
   * ARM resource ID of the Cosmos DB account to add, e.g.
   * `account.accountId`. Changing it replaces the membership.
   */
  databaseAccountId: string;
  /**
   * Location of the Cosmos DB account, e.g. `account.location`. Changing it
   * replaces the membership.
   * @default the provider's default location
   */
  accountLocation?: string;
  /**
   * Name of the membership within the fleetspace. Changing it replaces the
   * membership.
   * @default the account name from `databaseAccountId`
   */
  name?: string;
}

export interface FleetspaceAccount extends Resource<
  "Azure.CosmosDB.FleetspaceAccount",
  FleetspaceAccountProps,
  {
    /** Name of the membership within the fleetspace. */
    fleetspaceAccountName: string;
    /** ARM resource ID of the membership. */
    fleetspaceAccountId: string;
    /** Name of the fleetspace. */
    fleetspace: string;
    /** Name of the fleet. */
    fleet: string;
    /** Resource group of the fleet. */
    resourceGroup: string;
    /** ARM resource ID of the member Cosmos DB account. */
    databaseAccountId: string;
    /** Location of the member Cosmos DB account. */
    accountLocation: string;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Membership of an Azure Cosmos DB account in a {@link Fleetspace}. An
 * account belongs to at most one fleetspace; adding it to a fleetspace with
 * a throughput pool lets it burst into the pool's shared RU/s.
 *
 * Memberships cannot be tagged or updated in place: every property change
 * removes the account from the fleetspace and adds it again. Destroying the
 * membership removes the account from the fleetspace; the account itself is
 * not deleted.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/fleet
 *
 * ### Adding an Account to a Fleetspace
 * **Example:** Add a NoSQL account
 * ```typescript
 * const fleet = yield* Azure.CosmosDB.Fleet("tenants", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const space = yield* Azure.CosmosDB.Fleetspace("standard", {
 *   resourceGroup: group.resourceGroupName,
 *   fleet: fleet.fleetName,
 * });
 * const account = yield* Azure.CosmosDB.DatabaseAccount("tenant-a", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.CosmosDB.FleetspaceAccount("tenant-a-membership", {
 *   resourceGroup: group.resourceGroupName,
 *   fleet: fleet.fleetName,
 *   fleetspace: space.fleetspaceName,
 *   databaseAccountId: account.accountId,
 *   accountLocation: account.location,
 * });
 * ```
 *
 * @resource
 */
export const FleetspaceAccount = Resource<FleetspaceAccount>(
  "Azure.CosmosDB.FleetspaceAccount",
);

const normalizeRegion = (region: string) =>
  region.toLowerCase().replace(/\s+/g, "");

const accountNameOf = (databaseAccountId: string) =>
  databaseAccountId.replace(/\/+$/, "").split("/").pop() ?? "";

const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

const getFleetspaceAccount = (
  subscriptionId: string,
  resourceGroupName: string,
  fleetName: string,
  fleetspaceName: string,
  fleetspaceAccountName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetFleetspaceAccount({
      subscriptionId,
      resourceGroupName,
      fleetName,
      fleetspaceName,
      fleetspaceAccountName,
    }),
  );

type Observed = cosmos.GetFleetspaceAccountResponse;

/** Fleetspace accounts report `Online` or `Succeeded` once usable. */
const stateOf = (member: Observed) => {
  const state = member.properties?.provisioningState;
  return state === "Online" ? "Succeeded" : state;
};

const toAttrs = (
  resourceGroup: string,
  fleet: string,
  fleetspace: string,
  name: string,
  fallback: { databaseAccountId: string; accountLocation: string },
  member: Observed,
): FleetspaceAccount["Attributes"] => {
  const global = member.properties?.globalDatabaseAccountProperties;
  return {
    fleetspaceAccountName: name,
    fleetspaceAccountId: member.id ?? "",
    fleetspace,
    fleet,
    resourceGroup,
    databaseAccountId: global?.resourceId ?? fallback.databaseAccountId,
    accountLocation: normalizeRegion(
      global?.armLocation ?? fallback.accountLocation,
    ),
    provisioningState: member.properties?.provisioningState,
  };
};

export const FleetspaceAccountProvider = () =>
  Provider.succeed(FleetspaceAccount, {
    stables: [
      "fleetspaceAccountName",
      "fleetspaceAccountId",
      "fleetspace",
      "fleet",
      "resourceGroup",
      "databaseAccountId",
      "accountLocation",
    ],

    // Memberships disappear with their fleetspace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.fleet !== output.fleet ||
        news.fleetspace !== output.fleetspace ||
        !sameId(news.databaseAccountId, output.databaseAccountId) ||
        (news.accountLocation !== undefined &&
          normalizeRegion(news.accountLocation) !== output.accountLocation) ||
        (news.name ?? accountNameOf(news.databaseAccountId)) !==
          output.fleetspaceAccountName
      ) {
        // An account belongs to at most one fleetspace of a fleet, so the
        // old membership must go before the new one is added.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId, location } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const fleet = output?.fleet ?? olds?.fleet;
      const fleetspace = output?.fleetspace ?? olds?.fleetspace;
      const databaseAccountId =
        output?.databaseAccountId ?? olds?.databaseAccountId;
      if (
        resourceGroup === undefined ||
        fleet === undefined ||
        fleetspace === undefined ||
        databaseAccountId === undefined
      ) {
        return undefined;
      }
      const name =
        output?.fleetspaceAccountName ??
        olds?.name ??
        accountNameOf(databaseAccountId);
      const observed = yield* getFleetspaceAccount(
        subscriptionId,
        resourceGroup,
        fleet,
        fleetspace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        fleet,
        fleetspace,
        name,
        {
          databaseAccountId,
          accountLocation:
            output?.accountLocation ?? olds?.accountLocation ?? location,
        },
        observed,
      );
      // A membership recorded by Alchemy is ours. Without a record there is
      // no marker to read back, so it is adopted only explicitly.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId, location } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DocumentDB");
      const { resourceGroup, fleet, fleetspace, databaseAccountId } = news;
      const accountLocation = normalizeRegion(news.accountLocation ?? location);
      const name = news.name ?? accountNameOf(databaseAccountId);
      const label = `Cosmos DB fleetspace account ${name}`;
      const get = getFleetspaceAccount(
        subscriptionId,
        resourceGroup,
        fleet,
        fleetspace,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure. There is no update operation; every property is immutable.
      if (observed === undefined) {
        yield* cosmos
          .CreateFleetspaceAccount({
            subscriptionId,
            resourceGroupName: resourceGroup,
            fleetName: fleet,
            fleetspaceName: fleetspace,
            fleetspaceAccountName: name,
            properties: {
              globalDatabaseAccountProperties: {
                resourceId: databaseAccountId,
                armLocation: accountLocation,
              },
            },
          })
          .pipe(Effect.retry(whileAccountBusy));
      }
      const ready = yield* waitForProvisioned(label, get, stateOf, {
        interval: "5 seconds",
        times: 60,
      });

      return toAttrs(
        resourceGroup,
        fleet,
        fleetspace,
        name,
        { databaseAccountId, accountLocation },
        ready,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cosmos
          .DeleteFleetspaceAccount({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            fleetName: output.fleet,
            fleetspaceName: output.fleetspace,
            fleetspaceAccountName: output.fleetspaceAccountName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB fleetspace account ${output.fleetspaceAccountName}`,
        getFleetspaceAccount(
          subscriptionId,
          output.resourceGroup,
          output.fleet,
          output.fleetspace,
          output.fleetspaceAccountName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.CosmosDB.Fleetspace",
        "Azure.CosmosDB.DatabaseAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
