import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createRegistryName,
  getRegistry,
  matchesObserved,
  normalizeLocation,
  sameName,
} from "./Common.ts";

export type RegistrySku = "Basic" | "Standard" | "Premium";
export type RegistryNetworkRuleSet = containerregistry.NetworkRuleSet;
export type RegistryPolicies = containerregistry.PoliciesInput;

export interface RegistryIdentity {
  /** Managed identity type. */
  type: "SystemAssigned" | "UserAssigned" | "SystemAssigned, UserAssigned";
  /**
   * ARM resource IDs of user-assigned identities to attach (required for
   * `UserAssigned`).
   */
  userAssignedIdentities?: string[];
}

export interface RegistryProps {
  /** Resource group the registry is created in. Changing it replaces the registry. */
  resourceGroup: string;
  /**
   * Globally unique registry name (`{name}.azurecr.io`): 5-50 letters and
   * digits. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the registry.
   */
  name?: string;
  /**
   * Azure location of the registry. Changing it replaces the registry.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Service tier. Can be changed in place; downgrading fails while
   * Premium-only features (replications, network rules, ...) are in use.
   * @default "Basic"
   */
  sku?: RegistrySku;
  /**
   * Enable the admin user (username/password access). Prefer Entra ID or
   * repository-scoped tokens.
   * @default false
   */
  adminUserEnabled?: boolean;
  /**
   * Allow anonymous (unauthenticated) pulls. Standard and Premium only.
   * @default Azure's default (`false`)
   */
  anonymousPullEnabled?: boolean;
  /**
   * Whether the public endpoint accepts traffic.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /** IP firewall rules. Premium only. */
  networkRuleSet?: RegistryNetworkRuleSet;
  /**
   * Allow trusted Azure services to bypass the network rules.
   * @default Azure's default (`AzureServices`)
   */
  networkRuleBypassOptions?: "AzureServices" | "None";
  /** Allow ACR Tasks to bypass the network rules. */
  networkRuleBypassAllowedForTasks?: boolean;
  /** Serve data from dedicated regional data endpoints. Premium only. */
  dataEndpointEnabled?: boolean;
  /**
   * Zone redundancy (Premium, supported regions only). Changing it replaces
   * the registry.
   * @default Azure's default (`Disabled`)
   */
  zoneRedundancy?: "Enabled" | "Disabled";
  /**
   * Registry policies (quarantine, content trust, retention, export, ARM
   * audience tokens). Retention and trust are Premium only.
   */
  policies?: RegistryPolicies;
  /** Role assignment mode (`AbacRepositoryPermissions` enables repository-level ABAC). */
  roleAssignmentMode?:
    | "AbacRepositoryPermissions"
    | "LegacyRegistryPermissions";
  /** Managed identity of the registry (e.g. for customer-managed keys or credential sets). */
  identity?: RegistryIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Registry extends Resource<
  "Azure.ContainerRegistry.Registry",
  RegistryProps,
  {
    /** Name of the registry. */
    registryName: string;
    /** ARM resource ID of the registry; use it as a role-assignment scope. */
    registryId: string;
    /** Resource group that holds the registry. */
    resourceGroup: string;
    /** Location of the registry. */
    location: string;
    /** Login server, e.g. `myregistry.azurecr.io`. */
    loginServer: string;
    /** Service tier. */
    sku: string;
    /** Whether the admin user is enabled. */
    adminUserEnabled: boolean;
    /** Admin username (when the admin user is enabled). */
    adminUsername: string | undefined;
    /** Primary admin password (when the admin user is enabled). */
    adminPassword: Redacted.Redacted<string> | undefined;
    /** Zone redundancy of the registry. */
    zoneRedundancy: string;
    /** Regional data endpoint host names (when data endpoints are enabled). */
    dataEndpointHostNames: string[];
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Creation date (ISO 8601). */
    creationDate: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Container Registry — a private Docker/OCI registry at
 * `{name}.azurecr.io`.
 *
 * @see https://learn.microsoft.com/azure/container-registry/container-registry-intro
 *
 * ### Creating a Registry
 * **Example:** Basic registry
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const registry = yield* Azure.ContainerRegistry.Registry("images", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * // registry.loginServer === "<name>.azurecr.io"
 * ```
 *
 * **Example:** Standard registry with the admin user enabled
 * ```typescript
 * const registry = yield* Azure.ContainerRegistry.Registry("images", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Standard",
 *   adminUserEnabled: true,
 * });
 * // registry.adminUsername / registry.adminPassword (Redacted)
 * ```
 *
 * ### Network Restrictions
 * **Example:** Premium registry that only accepts one IP range
 * ```typescript
 * const registry = yield* Azure.ContainerRegistry.Registry("images", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Premium",
 *   networkRuleSet: {
 *     defaultAction: "Deny",
 *     ipRules: [{ action: "Allow", value: "203.0.113.0/24" }],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Registry = Resource<Registry>("Azure.ContainerRegistry.Registry");

type ObservedRegistry = containerregistry.GetRegistryResponse;

const toAttrs = (
  resourceGroup: string,
  name: string,
  registry: ObservedRegistry,
  credentials: containerregistry.RegistryListCredentialsResult | undefined,
): Registry["Attributes"] => {
  const props = registry.properties;
  const password = credentials?.passwords?.[0]?.value;
  return {
    registryName: name,
    registryId: registry.id ?? "",
    resourceGroup,
    location: registry.location,
    loginServer: props?.loginServer ?? `${name}.azurecr.io`,
    sku: registry.sku?.name ?? "",
    adminUserEnabled: props?.adminUserEnabled ?? false,
    adminUsername: credentials?.username,
    adminPassword: password === undefined ? undefined : Redacted.make(password),
    zoneRedundancy: props?.zoneRedundancy ?? "Disabled",
    dataEndpointHostNames: [...(props?.dataEndpointHostNames ?? [])],
    principalId: registry.identity?.principalId,
    creationDate: props?.creationDate,
    tags: userTags(registry.tags),
  };
};

const desiredIdentity = (
  identity: RegistryIdentity | undefined,
): containerregistry.IdentityPropertiesInput | undefined =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities: identity.userAssignedIdentities?.length
          ? Object.fromEntries(
              identity.userAssignedIdentities.map((id) => [id, {}]),
            )
          : undefined,
      };

const identityDiffers = (
  desired: RegistryIdentity | undefined,
  observed: containerregistry.IdentityProperties | undefined,
) => {
  const observedType = observed?.type ?? "None";
  if (desired === undefined) return observedType !== "None";
  if (
    desired.type.replace(/\s/g, "").toLowerCase() !==
    observedType.replace(/\s/g, "").toLowerCase()
  ) {
    return true;
  }
  const want = (desired.userAssignedIdentities ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  return want.length !== have.length || want.some((id, i) => id !== have[i]);
};

const listCredentials = (
  subscriptionId: string,
  resourceGroupName: string,
  registryName: string,
  adminUserEnabled: boolean,
) =>
  adminUserEnabled
    ? containerregistry.ListRegistryCredentials({
        subscriptionId,
        resourceGroupName,
        registryName,
      })
    : Effect.succeed(undefined);

export const RegistryProvider = () =>
  Provider.succeed(Registry, {
    stables: [
      "registryName",
      "registryId",
      "resourceGroup",
      "location",
      "loginServer",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* containerregistry
        .ListRegistries({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListRegistries", page)),
        );
      return (page.value ?? []).flatMap((registry) => {
        const group = resourceGroupOf(registry.id);
        return hasAnyAlchemyTag(registry.tags) &&
          group !== undefined &&
          registry.name !== undefined
          ? [toAttrs(group, registry.name, registry, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameName(news.name, output.registryName)) ||
        (news.location !== undefined &&
          normalizeLocation(news.location) !==
            normalizeLocation(output.location)) ||
        (news.zoneRedundancy !== undefined &&
          news.zoneRedundancy !== output.zoneRedundancy)
      ) {
        // A kept explicit name must be freed before it can be reused.
        return {
          action: "replace",
          deleteFirst:
            news.name !== undefined && sameName(news.name, output.registryName),
        } as const;
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
        output?.registryName ?? olds?.name ?? (yield* createRegistryName(id));
      const observed = yield* getRegistry(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const owned = yield* isOwned(id, observed.tags);
      const credentials = owned
        ? yield* listCredentials(
            subscriptionId,
            resourceGroup,
            name,
            observed.properties?.adminUserEnabled ?? false,
          )
        : undefined;
      const attrs = toAttrs(resourceGroup, name, observed, credentials);
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerRegistry");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.registryName ?? (yield* createRegistryName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = news.sku ?? "Basic";
      const desired: containerregistry.RegistryPropertiesUpdateParametersInput =
        {
          adminUserEnabled: news.adminUserEnabled ?? false,
          anonymousPullEnabled: news.anonymousPullEnabled,
          publicNetworkAccess: news.publicNetworkAccess,
          networkRuleSet: news.networkRuleSet,
          networkRuleBypassOptions: news.networkRuleBypassOptions,
          networkRuleBypassAllowedForTasks:
            news.networkRuleBypassAllowedForTasks,
          dataEndpointEnabled: news.dataEndpointEnabled,
          policies: news.policies,
          roleAssignmentMode: news.roleAssignmentMode,
        };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        registryName: name,
      };
      const label = `container registry ${name}`;
      const get = getRegistry(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(
        label,
        get,
        (registry) => registry.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* containerregistry.CreateRegistry({
          ...where,
          location,
          sku: { name: sku },
          tags,
          identity: desiredIdentity(news.identity),
          properties: {
            ...desired,
            zoneRedundancy: news.zoneRedundancy,
          },
        });
      }
      observed = yield* waitReady;

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const props = (observed.properties ?? {}) as Record<string, unknown>;
      const changed: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(desired)) {
        if (value !== undefined && !matchesObserved(value, props[key])) {
          changed[key] = value;
        }
      }
      const skuChanged = observed.sku?.name !== sku;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const identityChanged = identityDiffers(news.identity, observed.identity);
      if (
        Object.keys(changed).length > 0 ||
        skuChanged ||
        tagsChanged ||
        identityChanged
      ) {
        yield* containerregistry.UpdateRegistry({
          ...where,
          sku: skuChanged ? { name: sku } : undefined,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged
            ? (desiredIdentity(news.identity) ?? { type: "None" })
            : undefined,
          properties:
            Object.keys(changed).length > 0
              ? (changed as containerregistry.RegistryPropertiesUpdateParametersInput)
              : undefined,
        });
        observed = yield* waitReady;
      }

      const credentials = yield* listCredentials(
        subscriptionId,
        resourceGroup,
        name,
        observed.properties?.adminUserEnabled ?? false,
      );
      return toAttrs(resourceGroup, name, observed, credentials);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        containerregistry.DeleteRegistry({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          registryName: output.registryName,
        }),
      );
      yield* waitUntilGone(
        `container registry ${output.registryName}`,
        getRegistry(subscriptionId, output.resourceGroup, output.registryName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
