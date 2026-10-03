import * as storagemover from "@distilled.cloud/azure/storagemover";
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
import {
  createMoverName,
  DELETE_BUDGET,
  describe,
  isOwnedByDescription,
  userDescription,
} from "./Common.ts";

export type EndpointType =
  | "AzureStorageBlobContainer"
  | "AzureStorageSmbFileShare"
  | "AzureStorageNfsFileShare"
  | "NfsMount"
  | "SmbMount"
  | "AzureMultiCloudConnector"
  | "S3WithHMAC";

export interface EndpointCredentials {
  /** Key Vault secret URI holding the SMB username (`SmbMount`). */
  usernameUri?: string;
  /** Key Vault secret URI holding the SMB password (`SmbMount`). */
  passwordUri?: string;
  /** Key Vault secret URI holding the S3 access key (`S3WithHMAC`). */
  accessKeyUri?: string;
  /** Key Vault secret URI holding the S3 secret key (`S3WithHMAC`). */
  secretKeyUri?: string;
}

export interface EndpointIdentity {
  /** Managed identity type. */
  type:
    | "None"
    | "SystemAssigned"
    | "UserAssigned"
    | "SystemAssigned,UserAssigned";
  /** ARM IDs of user-assigned identities to attach. */
  userAssignedIdentities?: string[];
}

export interface EndpointProps {
  /** Resource group of the Storage Mover. Changing it replaces the endpoint. */
  resourceGroup: string;
  /** Storage Mover that holds the endpoint. Changing it replaces the endpoint. */
  storageMover: string;
  /**
   * Name of the endpoint: 1-64 letters, digits, `-` and `_`, starting with a
   * letter or digit. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the endpoint.
   */
  name?: string;
  /**
   * Kind of source or target the endpoint points at. Selects which of the
   * location fields below apply. Changing it replaces the endpoint.
   */
  endpointType: EndpointType;
  /**
   * Whether the endpoint is a migration source or target. Changing it
   * replaces the endpoint.
   * @default chosen by Azure from the endpoint type
   */
  endpointKind?: "Source" | "Target";
  /**
   * Description of the endpoint. Alchemy appends an ownership marker
   * (`[alchemy <stack>/<stage>/<id>]`) because endpoints have no tags.
   */
  description?: string;
  /**
   * ARM ID of the storage account (`AzureStorageBlobContainer`,
   * `AzureStorageSmbFileShare`, `AzureStorageNfsFileShare`). Changing it
   * replaces the endpoint.
   */
  storageAccountId?: string;
  /** Blob container name (`AzureStorageBlobContainer`). Changing it replaces the endpoint. */
  blobContainerName?: string;
  /**
   * File share name (`AzureStorageSmbFileShare`, `AzureStorageNfsFileShare`).
   * Changing it replaces the endpoint.
   */
  fileShareName?: string;
  /** Host name or IP of the server (`NfsMount`, `SmbMount`). Changing it replaces the endpoint. */
  host?: string;
  /** Directory exported by the NFS server (`NfsMount`). Changing it replaces the endpoint. */
  export?: string;
  /**
   * NFS protocol version (`NfsMount`). Changing it replaces the endpoint.
   * @default "NFSauto"
   */
  nfsVersion?: "NFSauto" | "NFSv3" | "NFSv4" | "NFSv4_1";
  /** SMB share name (`SmbMount`). Changing it replaces the endpoint. */
  shareName?: string;
  /**
   * Source flavour: `NfsMount`/`FSX-EFS` for `NfsMount`, `SmbMount`/`FSX-SMB`
   * for `SmbMount`, `MINIO`/`IBM`/`GCS`/`ALIBABA`/`DELL_EMC`/`OTHER` for
   * `S3WithHMAC`. Changing it replaces the endpoint.
   */
  sourceType?: string;
  /** ARM ID of the multi-cloud connector (`AzureMultiCloudConnector`). Changing it replaces the endpoint. */
  multiCloudConnectorId?: string;
  /** ARM ID of the AWS S3 bucket (`AzureMultiCloudConnector`). Changing it replaces the endpoint. */
  awsS3BucketId?: string;
  /** Source URI (`S3WithHMAC`). Changing it replaces the endpoint. */
  sourceUri?: string;
  /** Description of an `OTHER` source type (`S3WithHMAC`). Changing it replaces the endpoint. */
  otherSourceTypeDescription?: string;
  /** Key Vault secret URIs with the credentials (`SmbMount`, `S3WithHMAC`). */
  credentials?: EndpointCredentials;
  /**
   * Allow cross-tenant transfers (`AzureStorageBlobContainer`,
   * `AzureStorageSmbFileShare`).
   */
  enableCrossTenantTransfer?: boolean;
  /** Storage account ARM IDs allowed for cross-tenant transfers. */
  allowedStorageAccounts?: string[];
  /** Managed identity of the endpoint. */
  identity?: EndpointIdentity;
}

export interface Endpoint extends Resource<
  "Azure.StorageMover.Endpoint",
  EndpointProps,
  {
    /** Name of the endpoint. */
    endpointName: string;
    /** Storage Mover that holds the endpoint. */
    storageMover: string;
    /** Resource group of the Storage Mover. */
    resourceGroup: string;
    /** ARM resource ID of the endpoint. */
    endpointId: string;
    /** Kind of source or target the endpoint points at. */
    endpointType: string;
    /** Whether the endpoint is a migration source or target. */
    endpointKind: string | undefined;
    /** Description of the endpoint (ownership marker stripped). */
    description: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Storage Mover endpoint — a migration source (an NFS or SMB share, an S3
 * bucket) or target (an Azure blob container or file share).
 *
 * Endpoints have no tags, so Alchemy records ownership as a marker at the
 * end of the description.
 *
 * @see https://learn.microsoft.com/azure/storage-mover/endpoint-manage
 *
 * ### Target Endpoints
 * **Example:** Blob container target
 * ```typescript
 * const target = yield* Azure.StorageMover.Endpoint("target", {
 *   resourceGroup: group.resourceGroupName,
 *   storageMover: mover.storageMoverName,
 *   endpointType: "AzureStorageBlobContainer",
 *   storageAccountId: account.storageAccountId,
 *   blobContainerName: container.containerName,
 * });
 * ```
 *
 * ### Source Endpoints
 * **Example:** NFS share source
 * ```typescript
 * const source = yield* Azure.StorageMover.Endpoint("source", {
 *   resourceGroup: group.resourceGroupName,
 *   storageMover: mover.storageMoverName,
 *   endpointType: "NfsMount",
 *   host: "10.0.0.4",
 *   export: "/exports/data",
 *   nfsVersion: "NFSv4",
 * });
 * ```
 *
 * **Example:** SMB share source with Key Vault credentials
 * ```typescript
 * const source = yield* Azure.StorageMover.Endpoint("smb", {
 *   resourceGroup: group.resourceGroupName,
 *   storageMover: mover.storageMoverName,
 *   endpointType: "SmbMount",
 *   host: "fileserver.corp.local",
 *   shareName: "data",
 *   credentials: {
 *     usernameUri: "https://my-vault.vault.azure.net/secrets/smb-user",
 *     passwordUri: "https://my-vault.vault.azure.net/secrets/smb-password",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Endpoint = Resource<Endpoint>("Azure.StorageMover.Endpoint");

type ObservedEndpoint = storagemover.GetEndpointResponse;

const getEndpoint = (
  subscriptionId: string,
  resourceGroupName: string,
  storageMoverName: string,
  endpointName: string,
) =>
  orUndefinedIfNotFound(
    storagemover.GetEndpoint({
      subscriptionId,
      resourceGroupName,
      storageMoverName,
      endpointName,
    }),
  );

const credentialType = (endpointType: string) =>
  endpointType === "S3WithHMAC"
    ? "AzureKeyVaultS3WithHMAC"
    : "AzureKeyVaultSmb";

const desiredCredentials = (props: EndpointProps) =>
  props.credentials === undefined
    ? undefined
    : { type: credentialType(props.endpointType), ...props.credentials };

const desiredIdentity = (identity: EndpointIdentity | undefined) =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        ...(identity.userAssignedIdentities?.length
          ? {
              userAssignedIdentities: Object.fromEntries(
                identity.userAssignedIdentities.map((id) => [id, {}]),
              ),
            }
          : {}),
      };

const observedIdentity = (
  identity:
    | { type?: string; userAssignedIdentities?: Record<string, unknown> | null }
    | undefined,
) => {
  const ids = Object.keys(identity?.userAssignedIdentities ?? {});
  return {
    type: identity?.type ?? "None",
    ...(ids.length
      ? {
          userAssignedIdentities: Object.fromEntries(ids.map((id) => [id, {}])),
        }
      : {}),
  };
};

const identityKey = (
  identity:
    | { type?: string; userAssignedIdentities?: Record<string, unknown> | null }
    | undefined,
) =>
  JSON.stringify([
    identity?.type ?? "None",
    Object.keys(identity?.userAssignedIdentities ?? {})
      .map((id) => id.toLowerCase())
      .sort(),
  ]);

const credentialsDiffer = (observed: unknown, desired: EndpointCredentials) => {
  const current = (observed ?? {}) as Record<string, unknown>;
  return Object.entries(desired).some(
    ([key, value]) => (current[key] ?? "") !== (value ?? ""),
  );
};

const sameIds = (a: unknown, b: string[]) =>
  JSON.stringify(
    (Array.isArray(a) ? (a as string[]) : [])
      .map((s) => s.toLowerCase())
      .sort(),
  ) === JSON.stringify(b.map((s) => s.toLowerCase()).sort());

const toAttrs = (
  resourceGroup: string,
  storageMover: string,
  name: string,
  endpoint: ObservedEndpoint,
): Endpoint["Attributes"] => ({
  endpointName: name,
  storageMover,
  resourceGroup,
  endpointId: endpoint.id ?? "",
  endpointType: endpoint.properties.endpointType,
  endpointKind: endpoint.properties.endpointKind,
  description: userDescription(endpoint.properties.description),
  principalId: endpoint.identity?.principalId,
});

export const EndpointProvider = () =>
  Provider.succeed(Endpoint, {
    stables: [
      "endpointName",
      "storageMover",
      "resourceGroup",
      "endpointId",
      "endpointType",
    ],

    // Endpoints are deleted with their Storage Mover.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.storageMover.toLowerCase() !== output.storageMover.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.endpointName.toLowerCase()) ||
        news.endpointType !== output.endpointType ||
        (news.endpointKind !== undefined &&
          output.endpointKind !== undefined &&
          news.endpointKind !== output.endpointKind)
      ) {
        return { action: "replace" } as const;
      }
      if (olds !== undefined) {
        const immutable = [
          "storageAccountId",
          "blobContainerName",
          "fileShareName",
          "host",
          "export",
          "nfsVersion",
          "shareName",
          "sourceType",
          "multiCloudConnectorId",
          "awsS3BucketId",
          "sourceUri",
          "otherSourceTypeDescription",
        ] as const;
        // ARM IDs compare case-insensitively; paths and names exactly.
        const norm = (key: (typeof immutable)[number], value?: string) =>
          key === "storageAccountId" ? value?.toLowerCase() : value;
        if (
          immutable.some((key) => norm(key, news[key]) !== norm(key, olds[key]))
        ) {
          return { action: "replace" } as const;
        }
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageMover = output?.storageMover ?? olds?.storageMover;
      if (resourceGroup === undefined || storageMover === undefined) {
        return undefined;
      }
      const name =
        output?.endpointName ?? olds?.name ?? (yield* createMoverName(id));
      const observed = yield* getEndpoint(
        subscriptionId,
        resourceGroup,
        storageMover,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageMover, name, observed);
      return (yield* isOwnedByDescription(id, observed.properties.description))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.StorageMover");
      const { resourceGroup, storageMover, endpointType } = news;
      const name =
        news.name ?? output?.endpointName ?? (yield* createMoverName(id));
      const description = yield* describe(id, news.description);
      const credentials = desiredCredentials(news);
      const identity = desiredIdentity(news.identity);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        storageMoverName: storageMover,
        endpointName: name,
      };
      const get = getEndpoint(
        subscriptionId,
        resourceGroup,
        storageMover,
        name,
      );

      // Observe.
      const observed = yield* get;

      if (observed === undefined) {
        // Ensure: the PUT carries the variant-specific location fields.
        yield* storagemover.EndpointsCreateOrUpdate({
          ...where,
          properties: {
            endpointType,
            endpointKind: news.endpointKind,
            description,
            storageAccountResourceId: news.storageAccountId,
            blobContainerName: news.blobContainerName,
            fileShareName: news.fileShareName,
            host: news.host,
            export: news.export,
            nfsVersion: news.nfsVersion,
            shareName: news.shareName,
            sourceType: news.sourceType,
            multiCloudConnectorId: news.multiCloudConnectorId,
            awsS3BucketId: news.awsS3BucketId,
            sourceUri: news.sourceUri,
            otherSourceTypeDescription: news.otherSourceTypeDescription,
            credentials,
            enableCrossTenantTransfer: news.enableCrossTenantTransfer,
            allowedStorageAccounts: news.allowedStorageAccounts,
          },
          identity,
        });
      } else {
        // Sync the mutable aspects against the observed endpoint.
        const props = observed.properties;
        const descriptionChanged = props.description !== description;
        const credentialsChanged =
          news.credentials !== undefined &&
          credentialsDiffer(props.credentials, news.credentials);
        const crossTenantChanged =
          (news.enableCrossTenantTransfer !== undefined &&
            props.enableCrossTenantTransfer !==
              news.enableCrossTenantTransfer) ||
          (news.allowedStorageAccounts !== undefined &&
            !sameIds(
              props.allowedStorageAccounts,
              news.allowedStorageAccounts,
            ));
        const identityChanged =
          news.identity !== undefined &&
          identityKey(observed.identity ?? undefined) !== identityKey(identity);
        if (
          descriptionChanged ||
          credentialsChanged ||
          crossTenantChanged ||
          identityChanged
        ) {
          yield* storagemover.UpdateEndpoint({
            ...where,
            properties: {
              endpointType,
              ...(descriptionChanged ? { description } : {}),
              ...(credentialsChanged ? { credentials } : {}),
              ...(crossTenantChanged
                ? {
                    enableCrossTenantTransfer: news.enableCrossTenantTransfer,
                    allowedStorageAccounts: news.allowedStorageAccounts,
                  }
                : {}),
            },
            // The PATCH rejects a missing identity; resend the observed one.
            identity: identityChanged
              ? identity
              : observedIdentity(observed.identity ?? undefined),
          });
        }
      }

      const fresh = yield* waitForProvisioned(
        `storage mover endpoint ${name}`,
        get,
        (endpoint) => endpoint.properties.provisioningState,
      );
      return toAttrs(resourceGroup, storageMover, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storagemover.DeleteEndpoint({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          storageMoverName: output.storageMover,
          endpointName: output.endpointName,
        }),
      );
      yield* waitUntilGone(
        `storage mover endpoint ${output.endpointName}`,
        getEndpoint(
          subscriptionId,
          output.resourceGroup,
          output.storageMover,
          output.endpointName,
        ),
        DELETE_BUDGET,
      );
    }),
  });
