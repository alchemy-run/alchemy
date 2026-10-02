import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createNetworkName,
  sameId,
  waitNetworkGone,
  waitNetworkProvisioned,
  whileNetworkBusy,
} from "./common.ts";

export interface ApplicationSecurityGroupProps {
  /**
   * Resource group the application security group is created in. Changing
   * it replaces the group.
   */
  resourceGroup: string;
  /**
   * Name of the application security group: 1-80 letters, digits, `_`, `.`,
   * and `-`. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the group.
   */
  name?: string;
  /**
   * Azure location of the group. NICs and rules referencing it must be in
   * the same region. Changing it replaces the group.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ApplicationSecurityGroup extends Resource<
  "Azure.Network.ApplicationSecurityGroup",
  ApplicationSecurityGroupProps,
  {
    /** Name of the application security group. */
    applicationSecurityGroupName: string;
    /** ARM resource ID of the application security group. */
    applicationSecurityGroupId: string;
    /** Resource group that holds the group. */
    resourceGroup: string;
    /** Location of the group. */
    location: string;
    /** Immutable GUID Azure assigned to the group. */
    resourceGuid: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure application security group (ASG) — a named group of network
 * interfaces that security rules can target instead of explicit IP
 * addresses.
 *
 * Reference the group from `Azure.Network.SecurityRule`
 * (`sourceApplicationSecurityGroupIds` / `destinationApplicationSecurityGroupIds`).
 *
 * @see https://learn.microsoft.com/azure/virtual-network/application-security-groups
 *
 * ### Creating an Application Security Group
 * **Example:** Group for web servers
 * ```typescript
 * const web = yield* Azure.Network.ApplicationSecurityGroup("web", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * ### Using the Group in a Security Rule
 * **Example:** Allow HTTPS to the web tier
 * ```typescript
 * yield* Azure.Network.SecurityRule("allow-https", {
 *   resourceGroup: group.resourceGroupName,
 *   networkSecurityGroup: nsg.networkSecurityGroupName,
 *   priority: 100,
 *   direction: "Inbound",
 *   access: "Allow",
 *   protocol: "Tcp",
 *   destinationPortRange: "443",
 *   destinationApplicationSecurityGroupIds: [web.applicationSecurityGroupId],
 * });
 * ```
 *
 * @resource
 */
export const ApplicationSecurityGroup = Resource<ApplicationSecurityGroup>(
  "Azure.Network.ApplicationSecurityGroup",
);

type Observed = network.GetApplicationSecurityGroupResponse;

const getGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  applicationSecurityGroupName: string,
) =>
  orUndefinedIfNotFound(
    network.GetApplicationSecurityGroup({
      subscriptionId,
      resourceGroupName,
      applicationSecurityGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  group: Observed,
): ApplicationSecurityGroup["Attributes"] => ({
  applicationSecurityGroupName: name,
  applicationSecurityGroupId: group.id ?? "",
  resourceGroup,
  location: group.location ?? "",
  resourceGuid: group.properties?.resourceGuid,
  tags: userTags(group.tags),
});

export const ApplicationSecurityGroupProvider = () =>
  Provider.succeed(ApplicationSecurityGroup, {
    stables: [
      "applicationSecurityGroupName",
      "applicationSecurityGroupId",
      "resourceGroup",
      "location",
      "resourceGuid",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* network
        .ListApplicationSecurityGroupAll({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListApplicationSecurityGroupAll", page),
          ),
        );
      return page.value.flatMap((group) => {
        const resourceGroup = resourceGroupOf(group.id);
        return hasAnyAlchemyTag(group.tags) &&
          resourceGroup !== undefined &&
          group.name !== undefined
          ? [toAttrs(resourceGroup, group.name, group)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.applicationSecurityGroupName)) ||
        (news.location !== undefined && !sameId(news.location, output.location))
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
        output?.applicationSecurityGroupName ??
        olds?.name ??
        (yield* createNetworkName(id));
      const observed = yield* getGroup(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.applicationSecurityGroupName ??
        (yield* createNetworkName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        applicationSecurityGroupName: name,
      };
      const get = getGroup(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure; the only mutable aspect is tags.
      if (observed === undefined) {
        yield* network
          .ApplicationSecurityGroupsCreateOrUpdate({ ...where, location, tags })
          .pipe(Effect.retry(whileNetworkBusy));
      } else if (tagsDiffer(observed.tags, tags)) {
        yield* network
          .UpdateApplicationSecurityGroupTags({ ...where, tags })
          .pipe(Effect.retry(whileNetworkBusy));
      }
      observed = yield* waitNetworkProvisioned(
        `application security group ${name}`,
        get,
      );
      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        network.DeleteApplicationSecurityGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          applicationSecurityGroupName: output.applicationSecurityGroupName,
        }),
      ).pipe(Effect.retry(whileNetworkBusy));
      yield* waitNetworkGone(
        `application security group ${output.applicationSecurityGroupName}`,
        getGroup(
          subscriptionId,
          output.resourceGroup,
          output.applicationSecurityGroupName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
