import * as msi from "@distilled.cloud/azure/msi";
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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface UserAssignedIdentityProps {
  /**
   * Resource group the identity is created in. Changing it replaces the
   * identity.
   */
  resourceGroup: string;
  /**
   * Name of the identity, 3-128 characters of letters, digits, `-`, and
   * `_`, starting with a letter or digit. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * identity.
   */
  name?: string;
  /**
   * Azure location of the identity. Changing it replaces the identity.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface UserAssignedIdentity extends Resource<
  "Azure.ManagedIdentity.UserAssignedIdentity",
  UserAssignedIdentityProps,
  {
    /** Name of the identity. */
    identityName: string;
    /** Resource group that holds the identity. */
    resourceGroup: string;
    /** ARM resource ID of the identity. */
    identityId: string;
    /** Location of the identity. */
    location: string;
    /**
     * Object ID of the identity's service principal. Use it as the
     * `principalId` of a role assignment.
     */
    principalId: string;
    /**
     * Application (client) ID of the identity, used by code running as
     * the identity to request tokens.
     */
    clientId: string;
    /** Microsoft Entra tenant the identity belongs to. */
    tenantId: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A user-assigned managed identity — a Microsoft Entra service principal
 * whose lifecycle Azure manages. Attach it to compute (Container Apps,
 * Functions, VMs) and grant it access with role assignments instead of
 * distributing keys.
 *
 * @see https://learn.microsoft.com/entra/identity/managed-identities-azure-resources/overview
 *
 * ### Creating an Identity
 * **Example:** Identity in a resource group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("api", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * ### Granting Access
 * **Example:** Let the identity read blobs in a storage account
 * ```typescript
 * yield* Azure.Authorization.RoleAssignment("api-reads-files", {
 *   scope: account.storageAccountId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataReader,
 *   principalId: identity.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * @resource
 */
export const UserAssignedIdentity = Resource<UserAssignedIdentity>(
  "Azure.ManagedIdentity.UserAssignedIdentity",
);

type ObservedIdentity = msi.GetUserAssignedIdentityResponse;

const getIdentity = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
) =>
  orUndefinedIfNotFound(
    msi.GetUserAssignedIdentity({
      subscriptionId,
      resourceGroupName,
      resourceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  identity: ObservedIdentity,
): UserAssignedIdentity["Attributes"] => ({
  identityName: name,
  resourceGroup,
  identityId: identity.id ?? "",
  location: identity.location,
  principalId: identity.properties?.principalId ?? "",
  clientId: identity.properties?.clientId ?? "",
  tenantId: identity.properties?.tenantId ?? "",
  tags: userTags(identity.tags),
});

export const UserAssignedIdentityProvider = () =>
  Provider.succeed(UserAssignedIdentity, {
    stables: [
      "identityName",
      "resourceGroup",
      "identityId",
      "location",
      "principalId",
      "clientId",
      "tenantId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* msi
        .ListUserAssignedIdentityBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListUserAssignedIdentityBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((identity) => {
        const group = resourceGroupOf(identity.id);
        return hasAnyAlchemyTag(identity.tags) &&
          group !== undefined &&
          identity.name !== undefined
          ? [toAttrs(group, identity.name, identity)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.identityName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      // An interrupted create can persist props with unresolved holes;
      // nothing can exist without its resource group.
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.identityName ??
        olds?.name ??
        (yield* createPhysicalName({ id, maxLength: 128 }));
      const observed = yield* getIdentity(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ManagedIdentity");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.identityName ??
        (yield* createPhysicalName({ id, maxLength: 128 }));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);

      // Observe.
      let observed = yield* getIdentity(subscriptionId, resourceGroup, name);

      // Ensure + sync tags: the PUT is a synchronous upsert, and the only
      // mutable aspect is tags, so one PUT covers both.
      if (observed === undefined || tagsDiffer(observed.tags, tags)) {
        observed = yield* msi.UserAssignedIdentitiesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          resourceName: name,
          location: observed?.location ?? location,
          tags,
        });
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const request = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        resourceName: output.identityName,
      };
      yield* ignoreNotFound(msi.DeleteUserAssignedIdentity(request));
      yield* waitUntilGone(
        `managed identity ${output.identityName}`,
        getIdentity(subscriptionId, output.resourceGroup, output.identityName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
