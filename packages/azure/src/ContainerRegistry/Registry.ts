import * as containerregistry from "@distilled.cloud/azure/containerregistry";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
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
  /**
   * Managed identity type: `SystemAssigned`, `UserAssigned`, or both
   * (`"SystemAssigned, UserAssigned"`).
   */
  type: "SystemAssigned" | "UserAssigned" | "SystemAssigned, UserAssigned";
  /**
   * ARM resource IDs of user-assigned identities to attach (required for
   * `UserAssigned`).
   */
  userAssignedIdentities?: string[];
}

export interface RegistryProps {
  /**
   * Resource group the registry is created in. Changing it replaces the registry.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
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
  /**
   * IP firewall rules: a `defaultAction` (`Allow` or `Deny`) and `ipRules`
   * with IPv4 addresses or CIDR ranges. Premium only.
   * @default Azure's default (`defaultAction: "Allow"`, no rules)
   */
  networkRuleSet?: RegistryNetworkRuleSet;
  /**
   * Allow trusted Azure services to bypass the network rules.
   * @default Azure's default (`AzureServices`)
   */
  networkRuleBypassOptions?: "AzureServices" | "None";
  /**
   * Allow ACR Tasks to bypass the network rules.
   * @default Azure's default (`false`)
   */
  networkRuleBypassAllowedForTasks?: boolean;
  /**
   * Serve layer data from dedicated regional data endpoints
   * (`{name}.{region}.data.azurecr.io`), so a firewall can allow them by
   * name. Premium only.
   * @default Azure's default (`false`)
   */
  dataEndpointEnabled?: boolean;
  /**
   * Zone redundancy (Premium, supported regions only). Changing it replaces
   * the registry.
   * @default Azure's default (`Disabled`)
   */
  zoneRedundancy?: "Enabled" | "Disabled";
  /**
   * Registry policies (quarantine, content trust, retention, export, ARM
   * audience tokens). Retention (`days` of untagged manifests) and trust
   * are Premium only.
   * @default Azure's defaults (quarantine, trust, and retention disabled)
   */
  policies?: RegistryPolicies;
  /**
   * Role assignment mode. `AbacRepositoryPermissions` lets a role
   * assignment's condition limit access to repositories;
   * `LegacyRegistryPermissions` applies a role to the whole registry.
   * @default Azure's default (`LegacyRegistryPermissions`)
   */
  roleAssignmentMode?: "AbacRepositoryPermissions" | "LegacyRegistryPermissions";
  /**
   * Managed identity of the registry (e.g. for customer-managed keys or
   * credential sets). Removing it removes the identity.
   * @default no identity
   */
  identity?: RegistryIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
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
    /** Service tier: `Basic`, `Standard`, or `Premium`. */
    sku: string;
    /** Whether the admin user is enabled. */
    adminUserEnabled: boolean;
    /** Admin username (when the admin user is enabled). */
    adminUsername: string | undefined;
    /** Primary admin password (when the admin user is enabled). */
    adminPassword: Redacted.Redacted<string> | undefined;
    /** Zone redundancy of the registry: `Enabled` or `Disabled`. */
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
 * An Azure Container Registry (`Microsoft.ContainerRegistry/registries`): a
 * private Docker/OCI registry at `{name}.azurecr.io` for your container
 * images, Helm charts, and other OCI artifacts.
 *
 * Alchemy creates a `Basic` registry in the stack's resource group with the
 * admin user and anonymous pull turned off, so every pull and push uses a
 * Microsoft Entra identity or a repository-scoped token. Container Apps,
 * Container App Jobs, container groups, and AKS workloads with `main` create
 * and use a registry like this for you.
 *
 * :::caution[Changing `name`, `resourceGroup`, `location`, or `zoneRedundancy` replaces the registry]
 * Alchemy creates a new, empty registry and deletes the old one with every
 * image in it. When you keep an explicit `name`, Alchemy deletes the old
 * registry first to free the name, so pulls fail until the new registry
 * exists and you push the images again.
 * :::
 *
 * :::caution[The subscription must allow the `Microsoft.ContainerRegistry` provider]
 * Alchemy registers the resource provider on the subscription before the
 * first registry. The deploying identity needs permission to register
 * resource providers.
 * :::
 *
 * @see https://learn.microsoft.com/azure/container-registry/container-registry-intro
 *
 * ### Creating a Registry
 * **Example:** Basic registry
 * ```typescript
 * const registry = yield* Azure.ContainerRegistry.Registry("images");
 * // registry.loginServer === "<name>.azurecr.io"
 * ```
 *
 * **Example:** Registry with a fixed name and region
 * ```typescript
 * const registry = yield* Azure.ContainerRegistry.Registry("images", {
 *   name: "contosoimages",
 *   location: "westeurope",
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * **Example:** Premium registry with zone redundancy
 * ```typescript
 * const registry = yield* Azure.ContainerRegistry.Registry("images", {
 *   sku: "Premium",
 *   zoneRedundancy: "Enabled",
 * });
 * ```
 *
 * ### Choosing a SKU
 * `Basic`, `Standard`, and `Premium` differ in included storage and
 * throughput. Only `Premium` supports network rules, private endpoints,
 * geo-replication, zone redundancy, data endpoints, and the retention and
 * content-trust policies. You can change `sku` in place; a downgrade fails
 * while a Premium-only feature is in use.
 *
 * **Example:** Upgrade to Standard
 * ```diff
 *  const registry = yield* Azure.ContainerRegistry.Registry("images", {
 * -  sku: "Basic",
 * +  sku: "Standard",
 *  });
 * ```
 *
 * ### Authentication
 * Prefer Entra ID: bindings and role assignments give each identity the
 * access it needs. For a tool that only speaks `docker login`, create a
 * repository-scoped `Token`. The admin user gives full push and pull
 * access to the whole registry; turn it on only when nothing else works.
 *
 * **Example:** Pull-only token for one repository
 * ```typescript
 * const registry = yield* Azure.ContainerRegistry.Registry("images");
 * const pull = yield* Azure.ContainerRegistry.ScopeMap("app-pull", {
 *   registry: registry.registryName,
 *   actions: ["repositories/app/content/read"],
 * });
 * const token = yield* Azure.ContainerRegistry.Token("ci", {
 *   registry: registry.registryName,
 *   scopeMapId: pull.scopeMapId,
 *   passwords: [{ name: "password1" }],
 * });
 * // docker login <loginServer> -u token.tokenName -p token.passwords[0].value
 * ```
 *
 * **Example:** Admin user
 * ```typescript
 * const registry = yield* Azure.ContainerRegistry.Registry("images", {
 *   adminUserEnabled: true,
 * });
 * // registry.adminUsername / registry.adminPassword (Redacted)
 * ```
 *
 * **Example:** Anonymous pulls for public images
 * ```typescript
 * const registry = yield* Azure.ContainerRegistry.Registry("public", {
 *   sku: "Standard",
 *   anonymousPullEnabled: true,
 * });
 * ```
 *
 * ### Network Restrictions
 * **Example:** Premium registry that only accepts one IP range
 * ```typescript
 * const registry = yield* Azure.ContainerRegistry.Registry("images", {
 *   sku: "Premium",
 *   networkRuleSet: {
 *     defaultAction: "Deny",
 *     ipRules: [{ action: "Allow", value: "203.0.113.0/24" }],
 *   },
 *   networkRuleBypassOptions: "AzureServices",
 * });
 * ```
 *
 * **Example:** Private registry behind a private endpoint
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("endpoints", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 * });
 * const registry = yield* Azure.ContainerRegistry.Registry("images", {
 *   sku: "Premium",
 *   publicNetworkAccess: "Disabled",
 *   dataEndpointEnabled: true,
 * });
 * const endpoint = yield* Azure.Network.PrivateEndpoint("acr", {
 *   subnetId: subnet.subnetId,
 *   privateLinkServiceConnections: [
 *     { privateLinkServiceId: registry.registryId, groupIds: ["registry"] },
 *   ],
 * });
 * ```
 *
 * ### Retention and Policies
 * **Example:** Purge untagged manifests after 7 days
 * ```typescript
 * const registry = yield* Azure.ContainerRegistry.Registry("images", {
 *   sku: "Premium",
 *   policies: {
 *     retentionPolicy: { status: "enabled", days: 7 },
 *     exportPolicy: { status: "disabled" },
 *   },
 * });
 * ```
 *
 * **Example:** Repository-level permissions (ABAC)
 * ```typescript
 * const registry = yield* Azure.ContainerRegistry.Registry("images", {
 *   roleAssignmentMode: "AbacRepositoryPermissions",
 * });
 * ```
 *
 * ### Geo-replication, Caching, and Tasks
 * **Example:** Replicate a Premium registry to West Europe
 * ```typescript
 * const registry = yield* Azure.ContainerRegistry.Registry("images", {
 *   sku: "Premium",
 * });
 * yield* Azure.ContainerRegistry.Replication("westeurope", {
 *   registry: registry.registryName,
 *   location: "westeurope",
 * });
 * ```
 *
 * **Example:** Cache a public image
 * ```typescript
 * yield* Azure.ContainerRegistry.CacheRule("hello", {
 *   registry: registry.registryName,
 *   sourceRepository: "mcr.microsoft.com/hello-world",
 *   targetRepository: "hello-world",
 * });
 * // docker pull <loginServer>/hello-world:latest
 * ```
 *
 * **Example:** Build an image from GitHub every night
 * ```typescript
 * yield* Azure.ContainerRegistry.Task("nightly", {
 *   registry: registry.registryName,
 *   platform: { os: "Linux" },
 *   step: {
 *     type: "Docker",
 *     contextPath: "https://github.com/Azure-Samples/acr-build-helloworld-node.git",
 *     dockerFilePath: "Dockerfile",
 *     imageNames: ["helloworld:{{.Run.ID}}"],
 *   },
 *   timerTriggers: [{ name: "nightly", schedule: "0 3 * * *" }],
 * });
 * ```
 *
 * ### Pulling Images from Runtimes
 * A Container App Job with `main` pushes its image to the registry you
 * pass as `registry` and pulls it with its managed identity.
 *
 * **Example:** Push a job's image to a shared registry
 * ```typescript
 * const env = yield* Azure.ContainerApps.ManagedEnvironment("env");
 * const registry = yield* Azure.ContainerRegistry.Registry("Shared");
 * const job = yield* Azure.ContainerApps.Job("Nightly", {
 *   main: "./src/nightly.ts",
 *   environmentId: env.environmentId,
 *   registry: { registryName: registry.registryName, resourceGroup: registry.resourceGroup },
 * });
 * ```
 *
 * To run your own image, give the runtime's identity **AcrPull** on the
 * registry. Use a user-assigned identity so the role exists before the
 * first pull.
 *
 * **Example:** Container App that pulls with a user-assigned identity
 * ```typescript
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
 * **Example:** Let an AKS cluster's kubelet pull images
 * ```typescript
 * const cluster = yield* Azure.ContainerService.ManagedCluster("aks");
 * yield* Azure.Authorization.RoleAssignment("aks-acr-pull", {
 *   scope: registry.registryId,
 *   roleDefinitionId: "7f951dda-4ed3-4680-a7ca-43fe172d538d", // AcrPull
 *   principalId: cluster.kubeletIdentity.objectId,
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * ### Binding to a runtime
 * Each data-plane operation is its own binding. A binding creates a custom
 * role with only that operation's permissions (for example
 * `AzureContainerRegistryPullRole` with `registries/pull/read` and
 * `repositories/content/read`) and assigns it on this registry only, so it
 * works in both role-assignment modes. On an Azure Function, Web App,
 * Container App, container group, VM, or AKS workload identity the role goes
 * to the host's managed identity; any other host gets an Entra service
 * principal.
 *
 * **Example:** List the tags of a repository from an Azure Function
 * ```typescript
 * const Images = Azure.ContainerRegistry.Registry("images");
 *
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const registry = yield* Images;
 *     const listTags = yield* Azure.ContainerRegistry.ListTags(registry);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { tags } = yield* listTags({ name: "app", orderby: "timedesc" });
 *         return yield* HttpServerResponse.json({ tags });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.ContainerRegistry.ListTagsHttp)),
 * ) {}
 * ```
 *
 * **Example:** Pull and push from a Container App
 * ```typescript
 * Effect.gen(function* () {
 *   const getManifest = yield* Azure.ContainerRegistry.GetManifest(registry);
 *   const putManifest = yield* Azure.ContainerRegistry.PutManifest(registry);
 *   // call them per request, as in Runtime Operations below
 *   return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 * }).pipe(
 *   Effect.provide([
 *     Azure.ContainerRegistry.GetManifestHttp,
 *     Azure.ContainerRegistry.PutManifestHttp,
 *   ]),
 * )
 * ```
 *
 * ### Runtime Operations
 * **Example:** Browse repositories and tags
 * ```typescript
 * // init
 * const listRepositories = yield* Azure.ContainerRegistry.ListRepositories(registry);
 * const getRepositoryProperties = yield* Azure.ContainerRegistry.GetRepositoryProperties(registry);
 *
 * // runtime
 * const { repositories } = yield* listRepositories();
 * const repo = yield* getRepositoryProperties({ name: "app" });
 * // repo.tagCount, repo.manifestCount
 * // …provided with Effect.provide([Azure.ContainerRegistry.ListRepositoriesHttp, Azure.ContainerRegistry.GetRepositoryPropertiesHttp])
 * ```
 *
 * **Example:** Read a manifest and its config blob
 * ```typescript
 * // init
 * const getManifest = yield* Azure.ContainerRegistry.GetManifest(registry);
 * const getBlob = yield* Azure.ContainerRegistry.GetBlob(registry);
 *
 * // runtime
 * const manifest = yield* getManifest({ name: "app", reference: "v1" });
 * const { body } = yield* getBlob({ name: "app", digest: manifest.config!.digest! });
 * ```
 *
 * **Example:** Push a blob and a manifest
 * ```typescript
 * // init
 * const uploadBlob = yield* Azure.ContainerRegistry.UploadBlob(registry);
 * const putManifest = yield* Azure.ContainerRegistry.PutManifest(registry);
 *
 * // runtime
 * const { digest } = yield* uploadBlob({ name: "app", body: new TextEncoder().encode("{}") });
 * const { dockerContentDigest } = yield* putManifest({
 *   name: "app",
 *   reference: "v1",
 *   contentType: "application/vnd.oci.image.manifest.v1+json",
 *   payload: new TextEncoder().encode(JSON.stringify(manifest)),
 * });
 * ```
 *
 * **Example:** Lock a tag and delete old images
 * ```typescript
 * // init
 * const updateTagAttributes = yield* Azure.ContainerRegistry.UpdateTagAttributes(registry);
 * const deleteTag = yield* Azure.ContainerRegistry.DeleteTag(registry);
 *
 * // runtime
 * yield* updateTagAttributes({ name: "app", reference: "v1", deleteEnabled: false });
 * yield* deleteTag({ name: "app", reference: "v0" });
 * // …provided with Effect.provide([Azure.ContainerRegistry.UpdateTagAttributesHttp, Azure.ContainerRegistry.DeleteTagHttp])
 * ```
 *
 * ### Event Sources
 * The registry publishes `Microsoft.ContainerRegistry.ImagePushed` and
 * `ImageDeleted` events to Event Grid. For an HTTP endpoint outside Azure,
 * use `Azure.ContainerRegistry.Webhook`.
 *
 * **Example:** Run a Function on every image push
 * ```typescript
 * yield* Azure.EventGrid.consumeEvents(
 *   "ImagePushed",
 *   {
 *     scope: registry.registryId,
 *     includedEventTypes: ["Microsoft.ContainerRegistry.ImagePushed"],
 *   },
 *   (event) => Effect.log(`pushed ${event.subject}`),
 * );
 * // …provided with Effect.provide(Azure.Functions.EventGridEventSource)
 * ```
 *
 * **Example:** Webhook on push to one repository
 * ```typescript
 * yield* Azure.ContainerRegistry.Webhook("deploy-hook", {
 *   registry: registry.registryName,
 *   serviceUri: "https://example.com/acr-hook",
 *   actions: ["push"],
 *   scope: "app:*",
 * });
 * ```
 *
 * @resource
 */
export const Registry = GroupedResource<Registry>("Azure.ContainerRegistry.Registry");

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
          ? Object.fromEntries(identity.userAssignedIdentities.map((id) => [id, {}]))
          : undefined,
      };

const identityDiffers = (
  desired: RegistryIdentity | undefined,
  observed: containerregistry.IdentityProperties | undefined,
) => {
  const observedType = observed?.type ?? "None";
  if (desired === undefined) return observedType !== "None";
  if (
    desired.type.replace(/\s/g, "").toLowerCase() !== observedType.replace(/\s/g, "").toLowerCase()
  ) {
    return true;
  }
  const want = (desired.userAssignedIdentities ?? []).map((id) => id.toLowerCase()).sort();
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
    stables: ["registryName", "registryId", "resourceGroup", "location", "loginServer"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(containerregistry.ListRegistries, { subscriptionId });
      return (page.value ?? []).flatMap((registry) => {
        const group = resourceGroupOf(registry.id);
        return hasAnyAlchemyTag(registry.tags) && group !== undefined && registry.name !== undefined
          ? [toAttrs(group, registry.name, registry, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameName(news.name, output.registryName)) ||
        (news.location !== undefined &&
          normalizeLocation(news.location) !== normalizeLocation(output.location)) ||
        (news.zoneRedundancy !== undefined && news.zoneRedundancy !== output.zoneRedundancy)
      ) {
        // A kept explicit name must be freed before it can be reused.
        return {
          action: "replace",
          deleteFirst: news.name !== undefined && sameName(news.name, output.registryName),
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
      const name = output?.registryName ?? olds?.name ?? (yield* createRegistryName(id));
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
      const name = news.name ?? output?.registryName ?? (yield* createRegistryName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const sku = news.sku ?? "Basic";
      const desired: containerregistry.RegistryPropertiesUpdateParametersInput = {
        adminUserEnabled: news.adminUserEnabled ?? false,
        anonymousPullEnabled: news.anonymousPullEnabled,
        publicNetworkAccess: news.publicNetworkAccess,
        networkRuleSet: news.networkRuleSet,
        networkRuleBypassOptions: news.networkRuleBypassOptions,
        networkRuleBypassAllowedForTasks: news.networkRuleBypassAllowedForTasks,
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
      if (Object.keys(changed).length > 0 || skuChanged || tagsChanged || identityChanged) {
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
