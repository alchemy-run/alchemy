import * as msi from "@distilled.cloud/azure/msi";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";

export interface UserAssignedIdentityProps {
  /**
   * Resource group the identity is created in. Changing it replaces the
   * identity.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
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
   * `alchemy::id`) are merged in automatically. Changing them updates the
   * identity in place.
   * @default {}
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
 * A user-assigned managed identity
 * (`Microsoft.ManagedIdentity/userAssignedIdentities`): a Microsoft Entra
 * service principal whose lifecycle Azure manages. Attach it to compute
 * (Container Apps, Web Apps, container groups, VMs) and grant it access
 * with role assignments instead of distributing keys.
 *
 * Unlike a system-assigned identity, it exists before the compute that
 * uses it, so its roles are in place on the compute's first start (for
 * example an AcrPull grant for the first image pull), and several apps can
 * share it. Bindings do not need one: they assign roles to the host's own
 * identity. Alchemy registers the `Microsoft.ManagedIdentity` resource
 * provider on the subscription if needed.
 *
 * :::caution[Changing `name`, `location`, or `resourceGroup` replaces the identity]
 * The new identity has a new `principalId` and `clientId`. Every role
 * assignment and federated credential that references the old one is
 * replaced, and compute that lists its `identityId` is updated. Code that
 * stored the old client ID stops getting tokens. Tags update in place.
 * :::
 *
 * @see https://learn.microsoft.com/entra/identity/managed-identities-azure-resources/overview
 *
 * ### Creating an Identity
 * **Example:** Identity in the stack's resource group
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("api");
 * ```
 *
 * **Example:** Identity with a fixed name, location, and tags
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("api", {
 *   name: "id-shop-api",
 *   location: "westeurope",
 *   tags: { team: "shop" },
 * });
 * ```
 *
 * ### Granting Access
 * Pass `principalId` to a role assignment, with
 * `principalType: "ServicePrincipal"`.
 *
 * **Example:** Let the identity read blobs in a storage account
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files");
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("api");
 * yield* Azure.Authorization.RoleAssignment("api-reads-files", {
 *   scope: account.storageAccountId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataReader,
 *   principalId: identity.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * **Example:** Let the identity read Key Vault secrets
 * ```typescript
 * const vault = yield* Azure.KeyVault.Vault("secrets");
 * yield* Azure.Authorization.RoleAssignment("api-reads-secrets", {
 *   scope: vault.vaultId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.KeyVaultSecretsUser,
 *   principalId: identity.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * ### Attaching to a Container App
 * List `identityId` in the app's `identity`. Use `"SystemAssigned,UserAssigned"`
 * to keep the system-assigned identity as well.
 *
 * **Example:** Pull a private image with the identity
 * ```typescript
 * const env = yield* Azure.ContainerApps.ManagedEnvironment("env");
 * const registry = yield* Azure.ContainerRegistry.Registry("images");
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("api-pull");
 * yield* Azure.Authorization.RoleAssignment("api-acr-pull", {
 *   scope: registry.registryId,
 *   roleDefinitionId: "7f951dda-4ed3-4680-a7ca-43fe172d538d", // AcrPull
 *   principalId: identity.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * const api = yield* Azure.ContainerApps.ContainerApp("api", {
 *   environmentId: env.environmentId,
 *   identity: { type: "UserAssigned", userAssignedIdentities: [identity.identityId] },
 *   configuration: {
 *     registries: [{ server: registry.loginServer, identity: identity.identityId }],
 *   },
 *   template: {
 *     containers: [{ name: "api", image: Output.interpolate`${registry.loginServer}/api:v1` }],
 *   },
 * });
 * ```
 *
 * **Example:** Tell the Azure SDK which identity to use
 * ```typescript
 * // With several identities attached, DefaultAzureCredential reads AZURE_CLIENT_ID.
 * const api = yield* Azure.ContainerApps.ContainerApp("api", {
 *   environmentId: env.environmentId,
 *   identity: {
 *     type: "SystemAssigned,UserAssigned",
 *     userAssignedIdentities: [identity.identityId],
 *   },
 *   template: {
 *     containers: [
 *       {
 *         name: "api",
 *         image: "mcr.microsoft.com/k8se/quickstart:latest",
 *         env: [{ name: "AZURE_CLIENT_ID", value: identity.clientId }],
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Attaching to a Web App
 * **Example:** Web App that runs as the identity
 * ```typescript
 * const plan = yield* Azure.Web.AppServicePlan("plan", { sku: "B1" });
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("site");
 * const site = yield* Azure.Web.WebApp("site", {
 *   serverFarmId: plan.appServicePlanId,
 *   identity: { type: "UserAssigned", userAssignedIdentityIds: [identity.identityId] },
 * });
 * ```
 *
 * ### Trusting External Workloads
 * Add an `Azure.ManagedIdentity.FederatedIdentityCredential` so GitHub
 * Actions or a Kubernetes service account signs in as the identity with
 * its own OIDC token, without a secret.
 *
 * **Example:** Deploy from GitHub Actions as the identity
 * ```typescript
 * const deployer = yield* Azure.ManagedIdentity.UserAssignedIdentity("deployer");
 * yield* Azure.ManagedIdentity.FederatedIdentityCredential("github-main", {
 *   identity: deployer.identityName,
 *   issuer: "https://token.actions.githubusercontent.com",
 *   subject: "repo:my-org/my-repo:ref:refs/heads/main",
 * });
 * // In the workflow, azure/login takes client-id: deployer.clientId and
 * // tenant-id: deployer.tenantId.
 * return { clientId: deployer.clientId, tenantId: deployer.tenantId };
 * ```
 *
 * @resource
 */
export const UserAssignedIdentity = GroupedResource<UserAssignedIdentity>(
  "Azure.ManagedIdentity.UserAssignedIdentity",
);

type ObservedIdentity = msi.GetUserAssignedIdentityResponse;

const getIdentity = (subscriptionId: string, resourceGroupName: string, resourceName: string) =>
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
      const page = yield* collectAll(msi.ListUserAssignedIdentityBySubscription, {
        subscriptionId,
      });
      return (page.value ?? []).flatMap((identity) => {
        const group = resourceGroupOf(identity.id);
        return hasAnyAlchemyTag(identity.tags) && group !== undefined && identity.name !== undefined
          ? [toAttrs(group, identity.name, identity)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
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
        output?.identityName ?? olds?.name ?? (yield* createPhysicalName({ id, maxLength: 128 }));
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
        news.name ?? output?.identityName ?? (yield* createPhysicalName({ id, maxLength: 128 }));
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
