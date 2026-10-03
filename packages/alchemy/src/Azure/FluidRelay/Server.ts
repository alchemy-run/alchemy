import * as fluidrelay from "@distilled.cloud/azure/fluidrelay";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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

/** Managed identity type of a Fluid Relay server. */
export type ServerIdentityType =
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned, UserAssigned"
  | "None";

/** Managed identity configuration of a Fluid Relay server. */
export interface ServerIdentity {
  /** Managed identity type. */
  type: ServerIdentityType;
  /**
   * ARM IDs of user-assigned identities to attach (required for
   * `UserAssigned` types).
   */
  userAssignedIdentityIds?: string[];
}

/** Customer-managed key (CMK) encryption of a Fluid Relay server. */
export interface ServerCustomerManagedKeyEncryption {
  /**
   * Versioned or versionless Key Vault key URL used as the key encryption
   * key.
   */
  keyEncryptionKeyUrl: string;
  /**
   * Identity used to reach the key vault. `SystemAssigned` uses the
   * server's system-assigned identity; `UserAssigned` requires
   * `userAssignedIdentityResourceId`.
   */
  identityType: "SystemAssigned" | "UserAssigned";
  /**
   * ARM ID of the user-assigned identity used to reach the key vault, when
   * `identityType` is `UserAssigned`. It must also be listed in
   * `identity.userAssignedIdentityIds`.
   */
  userAssignedIdentityResourceId?: string;
}

export interface ServerProps {
  /**
   * Resource group the server is created in. Changing it replaces the
   * server.
   */
  resourceGroup: string;
  /**
   * Name of the server, 1-50 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the server.
   */
  name?: string;
  /**
   * Azure location of the server. Fluid Relay is only offered in a subset
   * of regions (e.g. `eastus`, `westus2`, `westeurope`, `southeastasia`).
   * Changing it replaces the server.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Storage SKU for the server's document storage. Immutable after
   * creation; changing it replaces the server. ARM currently rejects
   * `basic` with an internal server error in several regions.
   * @default "standard"
   */
  storagesku?: "standard" | "basic";
  /**
   * Managed identity of the server. Required for customer-managed key
   * encryption. Omit to leave the observed identity unchanged.
   */
  identity?: ServerIdentity;
  /**
   * Customer-managed key encryption. Omit to leave the observed encryption
   * settings unchanged (Microsoft-managed keys by default).
   */
  customerManagedKeyEncryption?: ServerCustomerManagedKeyEncryption;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Server extends Resource<
  "Azure.FluidRelay.Server",
  ServerProps,
  {
    /** Name of the server. */
    serverName: string;
    /** ARM resource ID of the server. */
    serverId: string;
    /** Resource group that holds the server. */
    resourceGroup: string;
    /** Location of the server. */
    location: string;
    /**
     * Fluid Relay tenant ID. Pass it as the `tenantId` of the Azure Fluid
     * Relay client connection config.
     */
    frsTenantId: string;
    /** Orderer (websocket) endpoints of the server. */
    ordererEndpoints: string[];
    /** Storage endpoints of the server. */
    storageEndpoints: string[];
    /**
     * Service endpoints of the server. Pass the first one as the `endpoint`
     * of the Azure Fluid Relay client connection config.
     */
    serviceEndpoints: string[];
    /** Storage SKU of the server. */
    storagesku: string | undefined;
    /** Object ID of the server's system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** Tenant of the server's system-assigned identity, if enabled. */
    tenantId: string | undefined;
    /** Primary key used to sign tokens for Fluid Relay clients. */
    primaryKey: Redacted.Redacted<string> | undefined;
    /** Secondary key used to sign tokens for Fluid Relay clients. */
    secondaryKey: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Fluid Relay server — a managed service that hosts the
 * real-time collaboration backend for Fluid Framework applications.
 * Clients connect to its service endpoint using the tenant ID and tokens
 * signed with the server's keys.
 *
 * @see https://learn.microsoft.com/azure/azure-fluid-relay/overview/overview
 *
 * ### Creating a Server
 * **Example:** Server in a resource group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const relay = yield* Azure.FluidRelay.Server("relay", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Basic storage SKU
 * ```typescript
 * const relay = yield* Azure.FluidRelay.Server("relay", {
 *   resourceGroup: group.resourceGroupName,
 *   storagesku: "basic",
 * });
 * ```
 *
 * ### Connecting Clients
 * **Example:** Expose the connection settings
 * ```typescript
 * return {
 *   tenantId: relay.frsTenantId,
 *   endpoint: relay.serviceEndpoints,
 * };
 * ```
 *
 * ### Managed Identity
 * **Example:** System-assigned identity
 * ```typescript
 * const relay = yield* Azure.FluidRelay.Server("relay", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: { type: "SystemAssigned" },
 * });
 * ```
 *
 * @resource
 */
export const Server = Resource<Server>("Azure.FluidRelay.Server");

type ObservedServer = fluidrelay.GetFluidRelayServerResponse;

const getServer = (
  subscriptionId: string,
  resourceGroup: string,
  fluidRelayServerName: string,
) =>
  orUndefinedIfNotFound(
    fluidrelay.GetFluidRelayServer({
      subscriptionId,
      resourceGroup,
      fluidRelayServerName,
    }),
  );

const getKeys = (
  subscriptionId: string,
  resourceGroup: string,
  fluidRelayServerName: string,
) =>
  orUndefinedIfNotFound(
    fluidrelay.ListFluidRelayServerKeys({
      subscriptionId,
      resourceGroup,
      fluidRelayServerName,
    }),
  );

const physicalName = (id: string) =>
  createPhysicalName({ id, maxLength: 50, lowercase: true, delimiter: "-" });

const redact = (value: string | undefined) =>
  value === undefined ? undefined : Redacted.make(value);

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedServer,
  keys: fluidrelay.FluidRelayServerKeys | undefined,
): Server["Attributes"] => {
  const endpoints = observed.properties?.fluidRelayEndpoints;
  return {
    serverName: name,
    serverId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    frsTenantId: observed.properties?.frsTenantId ?? "",
    ordererEndpoints: [...(endpoints?.ordererEndpoints ?? [])],
    storageEndpoints: [...(endpoints?.storageEndpoints ?? [])],
    serviceEndpoints: [...(endpoints?.serviceEndpoints ?? [])],
    storagesku: observed.properties?.storagesku,
    principalId: observed.identity?.principalId,
    tenantId: observed.identity?.tenantId,
    primaryKey: redact(keys?.key1),
    secondaryKey: redact(keys?.key2),
    tags: userTags(observed.tags),
  };
};

const normalizeType = (type: string | undefined) =>
  (type ?? "None").replace(/\s/g, "").toLowerCase();

const identityDiffers = (
  observed: fluidrelay.Identity | undefined,
  desired: ServerIdentity | undefined,
) => {
  if (desired === undefined) return false;
  if (normalizeType(observed?.type) !== normalizeType(desired.type)) {
    return true;
  }
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((key) => key.toLowerCase())
    .sort()
    .join(",");
  const want = (desired.userAssignedIdentityIds ?? [])
    .map((key) => key.toLowerCase())
    .sort()
    .join(",");
  return have !== want;
};

const toIdentityInput = (
  identity: ServerIdentity | undefined,
): fluidrelay.IdentityInput | undefined =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities: identity.userAssignedIdentityIds?.length
          ? Object.fromEntries(
              identity.userAssignedIdentityIds.map((armId) => [armId, {}]),
            )
          : undefined,
      };

const toEncryption = (
  cmk: ServerCustomerManagedKeyEncryption | undefined,
): fluidrelay.EncryptionProperties | undefined =>
  cmk === undefined
    ? undefined
    : {
        customerManagedKeyEncryption: {
          keyEncryptionKeyUrl: cmk.keyEncryptionKeyUrl,
          keyEncryptionKeyIdentity: {
            identityType: cmk.identityType,
            userAssignedIdentityResourceId: cmk.userAssignedIdentityResourceId,
          },
        },
      };

const encryptionDiffers = (
  observed: fluidrelay.EncryptionProperties | undefined,
  desired: ServerCustomerManagedKeyEncryption | undefined,
) => {
  if (desired === undefined) return false;
  const cmk = observed?.customerManagedKeyEncryption;
  return (
    cmk?.keyEncryptionKeyUrl !== desired.keyEncryptionKeyUrl ||
    cmk?.keyEncryptionKeyIdentity?.identityType !== desired.identityType ||
    (cmk?.keyEncryptionKeyIdentity?.userAssignedIdentityResourceId ?? "")
      .toLowerCase() !==
      (desired.userAssignedIdentityResourceId ?? "").toLowerCase()
  );
};

export const ServerProvider = () =>
  Provider.succeed(Server, {
    stables: [
      "serverName",
      "serverId",
      "resourceGroup",
      "location",
      "frsTenantId",
      "storagesku",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* fluidrelay
        .ListFluidRelayServerBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListFluidRelayServerBySubscription", page),
          ),
        );
      return page.value.flatMap((server) => {
        const group = resourceGroupOf(server.id);
        return hasAnyAlchemyTag(server.tags) &&
          group !== undefined &&
          server.name !== undefined
          ? [toAttrs(group, server.name, server, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.serverName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase()) ||
        (news.storagesku !== undefined &&
          output.storagesku !== undefined &&
          news.storagesku.toLowerCase() !== output.storagesku.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.serverName ?? olds?.name ?? (yield* physicalName(id));
      const observed = yield* getServer(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const keys = yield* getKeys(subscriptionId, resourceGroup, name);
      const attrs = toAttrs(resourceGroup, name, observed, keys);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.FluidRelay");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.serverName ?? (yield* physicalName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);

      // Observe.
      let observed = yield* getServer(subscriptionId, resourceGroup, name);

      // Ensure: the PUT is synchronous and carries every aspect.
      if (observed === undefined) {
        observed = yield* fluidrelay.FluidRelayServersCreateOrUpdate({
          subscriptionId,
          resourceGroup,
          fluidRelayServerName: name,
          location,
          tags,
          identity: toIdentityInput(news.identity),
          properties: {
            storagesku: news.storagesku,
            encryption: toEncryption(news.customerManagedKeyEncryption),
          },
        });
      }

      // Sync tags, identity, and encryption against observed state; PATCH
      // only the aspects that drifted.
      const patch: Omit<
        fluidrelay.UpdateFluidRelayServerRequest,
        "subscriptionId" | "resourceGroup" | "fluidRelayServerName"
      > = {
        ...(tagsDiffer(observed.tags, tags) ? { tags } : {}),
        ...(identityDiffers(observed.identity, news.identity)
          ? { identity: toIdentityInput(news.identity) }
          : {}),
        ...(encryptionDiffers(
          observed.properties?.encryption,
          news.customerManagedKeyEncryption,
        )
          ? {
              properties: {
                encryption: toEncryption(news.customerManagedKeyEncryption),
              },
            }
          : {}),
      };
      if (Object.keys(patch).length > 0) {
        observed = yield* fluidrelay.UpdateFluidRelayServer({
          subscriptionId,
          resourceGroup,
          fluidRelayServerName: name,
          ...patch,
        });
      }

      const keys = yield* getKeys(subscriptionId, resourceGroup, name);
      return toAttrs(resourceGroup, name, observed, keys);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        fluidrelay.DeleteFluidRelayServer({
          subscriptionId,
          resourceGroup: output.resourceGroup,
          fluidRelayServerName: output.serverName,
        }),
      );
      yield* waitUntilGone(
        `fluid relay server ${output.serverName}`,
        getServer(subscriptionId, output.resourceGroup, output.serverName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
