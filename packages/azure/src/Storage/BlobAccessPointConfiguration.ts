import { createHash } from "node:crypto";
import * as storage from "@distilled.cloud/azure/storage";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createStorageChildName } from "./StorageOwnership.ts";

/** The kind of S3-compatible data store behind a Blob Access Point. */
export type BlobAccessPointSourceType =
  | "NetAppOntap"
  | "AzureNetAppFiles"
  | "DellOneFs"
  | "Qumulo"
  | "Commvault"
  | "Nasuni"
  | "S3Compatible";

/** Reach the data store through an Azure Private Link service. */
export interface BlobAccessPointPrivateLink {
  /** ARM resource ID of the `Microsoft.Network/privateLinkServices` resource. */
  privateLinkId: string;
  /** Group ID of the private link resource. */
  groupId?: string;
  /** Azure region of the private link service. */
  location: string;
  /** Message sent with the private endpoint connection request. */
  requestMessage: string;
}

export interface BlobAccessPointConfigurationProps {
  /** Resource group of the storage account. Changing it replaces the configuration. */
  resourceGroup: string;
  /** Storage account that exposes the access point. Changing it replaces the configuration. */
  storageAccount: string;
  /**
   * Configuration name (3-63 lowercase letters, digits, and single
   * hyphens). If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the configuration.
   */
  name?: string;
  /**
   * Azure region; must match the storage account's region. Changing it
   * replaces the configuration.
   * @default the provider's default location
   */
  location?: string;
  /** Kind of the backing data store. Changing it replaces the configuration. */
  sourceType: BlobAccessPointSourceType;
  /**
   * S3 endpoint URL of the backing data store, e.g.
   * `https://s3.example.com`. Changing it replaces the configuration.
   */
  endpoint: string;
  /**
   * Reach the endpoint through a Private Link service instead of over the
   * network. Changing it replaces the configuration.
   */
  privateLink?: BlobAccessPointPrivateLink;
  /**
   * Whether Azure verifies the data store's TLS certificate chain.
   * @default "Perform"
   */
  tlsVerification?: "Perform" | "Skip";
  /** S3 access key ID used to sign requests to the data store. */
  accessKeyId: string;
  /** S3 secret access key. Azure never returns it; Alchemy tracks a fingerprint. */
  secretAccessKey: Redacted.Redacted<string>;
  /**
   * Region used by the request-signing algorithm.
   * @default "us-east-1"
   */
  signingRegion?: string;
  /**
   * Host used when computing request signatures.
   * @default the endpoint host
   */
  hostOverride?: string;
  /**
   * `Active` or `Inactive`.
   * @default "Active"
   */
  state?: "Active" | "Inactive";
  /** Description of the configuration (max 250 characters). */
  description?: string;
  /** Resource tags. Alchemy ownership tags are merged in. */
  tags?: Record<string, string>;
}

export interface BlobAccessPointConfiguration extends Resource<
  "Azure.Storage.BlobAccessPointConfiguration",
  BlobAccessPointConfigurationProps,
  {
    /** Name of the configuration. */
    configurationName: string;
    /** Storage account that exposes the access point. */
    storageAccount: string;
    /** Resource group of the storage account. */
    resourceGroup: string;
    /** ARM resource ID of the configuration. */
    configurationId: string;
    /** Azure region of the configuration. */
    location: string;
    /**
     * System-generated GUID. A blob container connects to the access
     * point by name and this ID.
     */
    uniqueId: string | undefined;
    /** `Active` or `Inactive`. */
    state: string | undefined;
    /** Description of the configuration. */
    description: string | undefined;
    /** Kind of the backing data store. */
    sourceType: string;
    /** `Endpoint` or `PrivateLink`. */
    connectionType: string | undefined;
    /** S3 endpoint URL of the backing data store. */
    endpoint: string | undefined;
    /** TLS certificate verification behavior. */
    tlsVerification: string | undefined;
    /** Name of the private endpoint Azure created (Private Link only). */
    privateEndpointName: string | undefined;
    /** S3 access key ID. */
    accessKeyId: string | undefined;
    /** Signing region. */
    signingRegion: string | undefined;
    /** Signing host override. */
    hostOverride: string | undefined;
    /** Status of the last connection test (`Succeeded` or `Failed`). */
    lastConnectionTestStatus: string | undefined;
    /** Fingerprint of the secret access key last sent to Azure. */
    secretFingerprint: Redacted.Redacted<string> | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Blob Access Point configuration
 * (`Microsoft.Storage/storageAccounts/blobAccessPointConfigurations`):
 * connects this storage account to an S3-compatible data store (NetApp
 * ONTAP, Azure NetApp Files, Dell OneFS, Qumulo, Commvault, Nasuni, or any
 * S3-compatible endpoint). A blob container created with
 * `blobAccessPointConfiguration` becomes a read-only virtual container
 * that forwards reads and lists to the data store.
 *
 * The storage account must set `dataCollaborationPolicy.allowBlobAccessPoints`
 * to `true`; otherwise Azure rejects the configuration with
 * `StorageDataCollaborationNotAllowed`.
 *
 * :::caution
 * Changing `storageAccount`, `resourceGroup`, `name`, `location`,
 * `sourceType`, `endpoint`, or `privateLink` replaces the configuration.
 * :::
 *
 * ### Connecting a Data Store
 * **Example:** S3-compatible endpoint with an access key
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files", {
 *   dataCollaborationPolicy: { allowBlobAccessPoints: true },
 * });
 * const accessPoint = yield* Azure.Storage.BlobAccessPointConfiguration("archive", {
 *   storageAccount: account.storageAccountName,
 *   sourceType: "S3Compatible",
 *   endpoint: "https://s3.example.com",
 *   accessKeyId: "AKIAEXAMPLE",
 *   secretAccessKey: yield* Config.redacted("ARCHIVE_SECRET_KEY"),
 *   description: "On-prem archive",
 * });
 * ```
 *
 * **Example:** Data store behind a Private Link service
 * ```typescript
 * yield* Azure.Storage.BlobAccessPointConfiguration("ontap", {
 *   storageAccount: account.storageAccountName,
 *   sourceType: "NetAppOntap",
 *   endpoint: "https://ontap.internal.example.com",
 *   privateLink: {
 *     privateLinkId: privateLinkService.privateLinkServiceId,
 *     location: "eastus",
 *     requestMessage: "Blob Access Point",
 *   },
 *   accessKeyId: "ontap-reader",
 *   secretAccessKey: yield* Config.redacted("ONTAP_SECRET_KEY"),
 * });
 * ```
 *
 * @resource
 */
export const BlobAccessPointConfiguration = GroupedResource<BlobAccessPointConfiguration>(
  "Azure.Storage.BlobAccessPointConfiguration",
);

const getConfiguration = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  blobAccessPointConfigurationName: string,
) =>
  orUndefinedIfNotFound(
    storage.GetBlobAccessPointConfiguration({
      subscriptionId,
      resourceGroupName,
      accountName,
      blobAccessPointConfigurationName,
    }),
  );

const normalizeLocation = (location: string) => location.toLowerCase().replace(/\s/g, "");

const fingerprintOf = (salt: string, secret: Redacted.Redacted<string>) =>
  Effect.sync(() =>
    Redacted.make(
      createHash("sha256")
        .update(`${salt}:${Redacted.value(secret)}`)
        .digest("hex"),
    ),
  );

const sameFingerprint = (
  a: Redacted.Redacted<string> | undefined,
  b: Redacted.Redacted<string> | undefined,
) => a !== undefined && b !== undefined && Redacted.value(a) === Redacted.value(b);

const toAttrs = (
  resourceGroup: string,
  storageAccount: string,
  name: string,
  observed: storage.GetBlobAccessPointConfigurationResponse,
  secretFingerprint: Redacted.Redacted<string> | undefined,
): BlobAccessPointConfiguration["Attributes"] => {
  const p = observed.properties;
  return {
    configurationName: name,
    storageAccount,
    resourceGroup,
    configurationId: observed.id ?? "",
    location: observed.location,
    uniqueId: p.uniqueId,
    state: p.state,
    description: p.description,
    sourceType: p.source.sourceType,
    connectionType: p.source.connection?.connectionType,
    endpoint: p.source.connection?.endpoint,
    tlsVerification: p.source.connection?.tlsVerification,
    privateEndpointName: p.source.connection?.privateEndpointName,
    accessKeyId: p.source.auth?.accessKeyId,
    signingRegion: p.source.auth?.signingRegion,
    hostOverride: p.source.auth?.hostOverride,
    lastConnectionTestStatus: p.lastConnectionTestStatus,
    secretFingerprint,
    tags: userTags(observed.tags),
  };
};

export const BlobAccessPointConfigurationProvider = () =>
  Provider.succeed(BlobAccessPointConfiguration, {
    stables: [
      "configurationName",
      "storageAccount",
      "resourceGroup",
      "configurationId",
      "location",
      "sourceType",
    ],

    // Configurations disappear with their storage account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const connectionType = news.privateLink === undefined ? "Endpoint" : "PrivateLink";
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.storageAccount !== output.storageAccount ||
        (news.name !== undefined && news.name !== output.configurationName) ||
        (news.location !== undefined &&
          normalizeLocation(news.location) !== normalizeLocation(output.location)) ||
        news.sourceType !== output.sourceType ||
        news.endpoint !== output.endpoint ||
        (output.connectionType !== undefined && connectionType !== output.connectionType)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageAccount = output?.storageAccount ?? olds?.storageAccount;
      if (resourceGroup === undefined || storageAccount === undefined) {
        return undefined;
      }
      const name = output?.configurationName ?? olds?.name ?? (yield* createStorageChildName(id));
      const observed = yield* getConfiguration(subscriptionId, resourceGroup, storageAccount, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        storageAccount,
        name,
        observed,
        output?.secretFingerprint,
      );
      return isOwned(id, observed.tags) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup, storageAccount } = news;
      const name = news.name ?? output?.configurationName ?? (yield* createStorageChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const state = news.state ?? "Active";
      const tlsVerification = news.tlsVerification ?? "Perform";
      const fingerprint = yield* fingerprintOf(
        `${resourceGroup}/${storageAccount}/${name}`,
        news.secretAccessKey,
      );
      const auth = {
        authType: "AccessKey",
        accessKeyId: news.accessKeyId,
        secretAccessKey: news.secretAccessKey,
        signingRegion: news.signingRegion,
        hostOverride: news.hostOverride,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: storageAccount,
        blobAccessPointConfigurationName: name,
      };
      const get = getConfiguration(subscriptionId, resourceGroup, storageAccount, name);

      // Observe.
      const observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const pl = news.privateLink;
        yield* storage.CreateBlobAccessPointConfiguration({
          ...where,
          location: news.location ?? output?.location ?? env.location,
          tags,
          properties: {
            state,
            description: news.description,
            source: {
              sourceType: news.sourceType,
              connection:
                pl === undefined
                  ? { connectionType: "Endpoint", endpoint: news.endpoint, tlsVerification }
                  : {
                      connectionType: "PrivateLink",
                      endpoint: news.endpoint,
                      tlsVerification,
                      privateLinkIdType: "ResourceId",
                      privateLinkId: pl.privateLinkId,
                      privateLinkGroupId: pl.groupId,
                      privateLinkLocation: pl.location,
                      requestMessage: pl.requestMessage,
                    },
              auth,
            },
          },
        });
      } else {
        // Sync mutable aspects against the observed configuration. Azure
        // never returns the secret, so a rotation is detected by fingerprint.
        const p = observed.properties;
        const observedAuth = p.source.auth;
        const sourceDrift =
          (p.source.connection?.tlsVerification ?? "Perform") !== tlsVerification ||
          observedAuth?.accessKeyId !== news.accessKeyId ||
          (news.signingRegion !== undefined &&
            observedAuth?.signingRegion !== news.signingRegion) ||
          (news.hostOverride !== undefined && observedAuth?.hostOverride !== news.hostOverride) ||
          !sameFingerprint(fingerprint, output?.secretFingerprint);
        if (
          (p.state ?? "Active") !== state ||
          (news.description !== undefined && p.description !== news.description) ||
          sourceDrift ||
          tagsDiffer(observed.tags, tags)
        ) {
          yield* storage.UpdateBlobAccessPointConfiguration({
            ...where,
            tags,
            properties: {
              state,
              description: news.description,
              source: sourceDrift
                ? {
                    sourceType: news.sourceType,
                    connection: {
                      connectionType: p.source.connection?.connectionType ?? "Endpoint",
                      tlsVerification,
                    },
                    auth,
                  }
                : undefined,
            },
          });
        }
      }

      const fresh = yield* waitForProvisioned(
        `blob access point configuration ${name}`,
        get,
        (value) => value.properties.provisioningState,
        { interval: "10 seconds", times: 30 },
      );
      return toAttrs(resourceGroup, storageAccount, name, fresh, fingerprint);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storage.DeleteBlobAccessPointConfiguration({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.storageAccount,
          blobAccessPointConfigurationName: output.configurationName,
        }),
      );
      yield* waitUntilGone(
        `blob access point configuration ${output.configurationName}`,
        getConfiguration(
          subscriptionId,
          output.resourceGroup,
          output.storageAccount,
          output.configurationName,
        ),
        { interval: "10 seconds", times: 30 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Storage.StorageAccount", "Azure.Resources.ResourceGroup"],
    },
  });
