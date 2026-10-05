import * as sql from "@distilled.cloud/azure/sql";
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
import { createChildName, lower } from "./common.ts";

export interface ServerTrustGroupProps {
  /** Resource group of the group. Changing it replaces the group. */
  resourceGroup: string;
  /**
   * Location of the group. Changing it replaces the group.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Group name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the group.
   */
  name?: string;
  /**
   * ARM IDs of the managed instances that trust each other. Changing the
   * members replaces the group.
   */
  groupMembers: string[];
  /**
   * Trust scopes. `GlobalTransactions` enables distributed transactions
   * across the members. Changing them replaces the group.
   * @default ["GlobalTransactions"]
   */
  trustScopes?: ("GlobalTransactions" | "ServiceBroker")[];
}

export interface ServerTrustGroup extends Resource<
  "Azure.Sql.ServerTrustGroup",
  ServerTrustGroupProps,
  {
    /** Name of the group. */
    serverTrustGroupName: string;
    /** ARM resource ID of the group. */
    serverTrustGroupId: string;
    /** Resource group of the group. */
    resourceGroup: string;
    /** Location of the group. */
    location: string;
    /** ARM IDs of the member managed instances. */
    groupMembers: string[];
    /** Trust scopes. */
    trustScopes: string[];
  },
  never,
  Providers
> {}

/**
 * A server trust group: a set of Azure SQL Managed Instances that trust
 * each other for cross-instance scenarios such as distributed
 * transactions.
 *
 * Server trust groups cannot be tagged; Alchemy treats a group as its own
 * when its name is the one Alchemy generated for this resource (or it was
 * created by a previous deploy). Membership cannot be edited in place, so
 * changing members or scopes replaces the group.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/managed-instance/server-trust-group-overview
 *
 * ### Distributed Transactions
 * **Example:** Trust two managed instances
 * ```typescript
 * yield* Azure.Sql.ServerTrustGroup("trust", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "centralus",
 *   groupMembers: [first.managedInstanceId, second.managedInstanceId],
 * });
 * ```
 *
 * **Example:** Explicit trust scopes
 * ```typescript
 * yield* Azure.Sql.ServerTrustGroup("trust", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "centralus",
 *   groupMembers: [first.managedInstanceId, second.managedInstanceId],
 *   trustScopes: ["GlobalTransactions", "ServiceBroker"],
 * });
 * ```
 *
 * @resource
 */
export const ServerTrustGroup = Resource<ServerTrustGroup>(
  "Azure.Sql.ServerTrustGroup",
);

type ObservedGroup = sql.GetServerTrustGroupResponse;

const getGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  locationName: string,
  serverTrustGroupName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetServerTrustGroup({
      subscriptionId,
      resourceGroupName,
      locationName,
      serverTrustGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  location: string,
  name: string,
  group: ObservedGroup,
): ServerTrustGroup["Attributes"] => ({
  serverTrustGroupName: name,
  serverTrustGroupId: group.id ?? "",
  resourceGroup,
  location,
  groupMembers: (group.properties?.groupMembers ?? []).map((m) => m.serverId),
  trustScopes: [...(group.properties?.trustScopes ?? [])],
});

/** Order- and case-insensitive set key. */
const setKey = (values: readonly string[]) =>
  JSON.stringify(values.map((v) => v.toLowerCase()).sort());

/** Trust group operations touch every member instance: poll up to 1 h. */
const BUDGET = { interval: "30 seconds", times: 120 } as const;

export const ServerTrustGroupProvider = () =>
  Provider.succeed(ServerTrustGroup, {
    stables: [
      "serverTrustGroupName",
      "serverTrustGroupId",
      "resourceGroup",
      "location",
      "groupMembers",
      "trustScopes",
    ],

    // No tags; trust groups are removed with their managed instances.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          news.name !== output.serverTrustGroupName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        setKey(news.groupMembers) !== setKey(output.groupMembers) ||
        setKey(news.trustScopes ?? ["GlobalTransactions"]) !==
          setKey(output.trustScopes)
      ) {
        // An instance belongs to at most one trust group: while the old
        // group exists its deletion never completes once a replacement
        // claims the same members, so delete it first.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const location = output?.location ?? olds?.location ?? env.location;
      const generated = yield* createChildName(id);
      const name = output?.serverTrustGroupName ?? olds?.name ?? generated;
      const observed = yield* getGroup(
        env.subscriptionId,
        resourceGroup,
        location,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, location, name, observed);
      return output !== undefined || name === generated
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const resourceGroup = news.resourceGroup;
      const location = news.location ?? output?.location ?? env.location;
      const name =
        news.name ??
        output?.serverTrustGroupName ??
        (yield* createChildName(id));
      const trustScopes = news.trustScopes ?? ["GlobalTransactions"];
      const get = getGroup(subscriptionId, resourceGroup, location, name);
      const matches = (group: ObservedGroup) => {
        const attrs = toAttrs(resourceGroup, location, name, group);
        return (
          setKey(attrs.groupMembers) === setKey(news.groupMembers) &&
          setKey(attrs.trustScopes) === setKey(trustScopes)
        );
      };

      // Observe, then create (or converge an adopted group) in one
      // long-running PUT.
      const observed = yield* get;
      if (observed === undefined || !matches(observed)) {
        yield* sql.ServerTrustGroupsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          locationName: location,
          serverTrustGroupName: name,
          properties: {
            groupMembers: news.groupMembers.map((serverId) => ({ serverId })),
            trustScopes,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `sql server trust group ${name}`,
        get,
        (group) => (matches(group) ? "Succeeded" : "Updating"),
        BUDGET,
      );
      return toAttrs(resourceGroup, location, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // Right after a create, the group is still being applied to its
      // members for a long time (over an hour observed) and a DELETE in
      // that window does not complete; re-issue it until the group is
      // gone: up to 24 rounds of 5 minutes.
      yield* ignoreNotFound(
        sql.DeleteServerTrustGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          locationName: output.location,
          serverTrustGroupName: output.serverTrustGroupName,
        }),
      ).pipe(
        Effect.andThen(
          waitUntilGone(
            `sql server trust group ${output.serverTrustGroupName}`,
            getGroup(
              subscriptionId,
              output.resourceGroup,
              output.location,
              output.serverTrustGroupName,
            ),
            { interval: "30 seconds", times: 10 },
          ),
        ),
        Effect.retry({
          while: (e) => e._tag === "Azure.DeleteTimedOut",
          times: 23,
        }),
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Sql.ManagedInstance"],
    },
  });
