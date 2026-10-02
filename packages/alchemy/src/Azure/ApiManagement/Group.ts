import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName, isParentOwned, sameName } from "./Common.ts";

export interface GroupProps {
  /** Resource group of the API Management service. Changing it replaces the group. */
  resourceGroup: string;
  /** API Management service that holds the group. Changing it replaces the group. */
  serviceName: string;
  /**
   * Group identifier (1-256 characters). If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces
   * the group.
   */
  name?: string;
  /**
   * Display name of the group (1-300 characters).
   * @default the group identifier
   */
  displayName?: string;
  /** Description; may contain HTML. */
  description?: string;
  /**
   * `custom` for a group managed in APIM, or `external` for a group that
   * mirrors an identity-provider group. Changing it replaces the group.
   * @default "custom"
   */
  type?: "custom" | "external";
  /**
   * Identity-provider group id for `external` groups, e.g.
   * `aad://contoso.onmicrosoft.com/groups/{objectId}`. Changing it replaces
   * the group.
   */
  externalId?: string;
}

export interface Group extends Resource<
  "Azure.ApiManagement.Group",
  GroupProps,
  {
    /** Group identifier. */
    groupName: string;
    /** ARM resource ID of the group. */
    groupId: string;
    /** API Management service that holds the group. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Display name. */
    displayName: string;
    /** Group type. */
    type: string;
  },
  never,
  Providers
> {}

/**
 * An API Management group of developer-portal users, used to control
 * product visibility. Groups are not available on the Consumption tier.
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-create-groups
 *
 * ### Creating a Group
 * **Example:** Custom group
 * ```typescript
 * const partners = yield* Azure.ApiManagement.Group("partners", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   displayName: "Partners",
 *   description: "External partner developers",
 * });
 * ```
 *
 * **Example:** Group mirroring a Microsoft Entra group
 * ```typescript
 * const staff = yield* Azure.ApiManagement.Group("staff", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   displayName: "Staff",
 *   type: "external",
 *   externalId: `aad://contoso.onmicrosoft.com/groups/${groupObjectId}`,
 * });
 * ```
 *
 * @resource
 */
export const Group = Resource<Group>("Azure.ApiManagement.Group");

const getGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  serviceName: string,
  groupId: string,
) =>
  orUndefinedIfNotFound(
    apim.GetGroup({ subscriptionId, resourceGroupName, serviceName, groupId }),
  );

const toAttrs = (
  resourceGroup: string,
  serviceName: string,
  name: string,
  group: apim.GetGroupResponse,
): Group["Attributes"] => ({
  groupName: name,
  groupId: group.id ?? "",
  serviceName,
  resourceGroup,
  displayName: group.properties?.displayName ?? name,
  type: group.properties?.type ?? "custom",
});

export const GroupProvider = () =>
  Provider.succeed(Group, {
    stables: ["groupName", "groupId", "serviceName", "resourceGroup", "type"],

    // Groups live inside a service; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.serviceName, output.serviceName) ||
        (news.name !== undefined && !sameName(news.name, output.groupName))
      ) {
        return { action: "replace" } as const;
      }
      if (
        (news.type ?? "custom") !== output.type ||
        (olds !== undefined && news.externalId !== olds.externalId)
      ) {
        // Same identifier: the old group must go before the new one is created.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serviceName = output?.serviceName ?? olds?.serviceName;
      if (resourceGroup === undefined || serviceName === undefined) {
        return undefined;
      }
      const name =
        output?.groupName ?? olds?.name ?? (yield* createEntityName(id));
      const observed = yield* getGroup(
        subscriptionId,
        resourceGroup,
        serviceName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serviceName, name, observed);
      // Built-in system groups are never ours.
      return !observed.properties?.builtIn &&
        (yield* isParentOwned(subscriptionId, resourceGroup, serviceName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiManagement");
      const { resourceGroup, serviceName } = news;
      const name =
        news.name ?? output?.groupName ?? (yield* createEntityName(id));
      const desired: apim.GroupCreateParametersProperties = {
        displayName: news.displayName ?? name,
        description: news.description,
        type: news.type ?? "custom",
        externalId: news.externalId,
      };

      // Observe, then create or sync with one upsert when anything differs.
      const observed = yield* getGroup(
        subscriptionId,
        resourceGroup,
        serviceName,
        name,
      );
      const props = observed?.properties;
      const inSync =
        props !== undefined &&
        props.displayName === desired.displayName &&
        (desired.description === undefined ||
          props.description === desired.description) &&
        props.type === desired.type &&
        (desired.externalId === undefined ||
          props.externalId === desired.externalId);
      const current =
        inSync && observed !== undefined
          ? observed
          : yield* apim.GroupCreateOrUpdate({
              subscriptionId,
              resourceGroupName: resourceGroup,
              serviceName,
              groupId: name,
              properties: desired,
            });
      return toAttrs(resourceGroup, serviceName, name, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        apim.DeleteGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serviceName: output.serviceName,
          groupId: output.groupName,
        }),
      );
      yield* waitUntilGone(
        `API Management group ${output.groupName}`,
        getGroup(
          subscriptionId,
          output.resourceGroup,
          output.serviceName,
          output.groupName,
        ),
        { interval: "2 seconds", times: 15 },
      );
    }),
  });
