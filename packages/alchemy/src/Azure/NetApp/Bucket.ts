import * as netapp from "@distilled.cloud/azure/netapp";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
  createNetAppName,
  getVolume,
  LRO_BUDGET,
  matchesObserved,
  ownedByStage,
  whileBusy,
} from "./Common.ts";

/** File-system identity used for object access through the bucket. */
export interface BucketFileSystemUser {
  /** NFS user (UID/GID) for NFS volumes. */
  nfsUser?: {
    /** User ID. */
    userId: number;
    /** Group ID. */
    groupId: number;
  };
  /** CIFS user for SMB volumes. */
  cifsUser?: {
    /** Active Directory user name. */
    username: string;
  };
}

/** Bucket server (S3 endpoint) settings. */
export interface BucketServer {
  /** Fully qualified domain name of the bucket server, e.g. `files.contoso.com`. */
  fqdn: string;
  /**
   * Base64-encoded PEM certificate (with private key) presented by the
   * server. Omit when the certificate comes from Key Vault (`akvDetails`).
   */
  certificateObject?: Redacted.Redacted<string>;
  /**
   * What to do when the volume's server already holds a certificate.
   * @default "Update"
   */
  onCertificateConflictAction?: "Update" | "Fail";
}

/** Key Vault locations of the server certificate and the generated credentials. */
export interface BucketKeyVaultDetails {
  /** Key Vault certificate used by the bucket server. */
  certificateAkvDetails?: {
    /** URI of the Key Vault holding the certificate. */
    certificateKeyVaultUri: string;
    /** Name of the certificate. */
    certificateName: string;
  };
  /** Key Vault secret receiving generated access credentials. */
  credentialsAkvDetails?: {
    /** URI of the Key Vault receiving the credentials. */
    credentialsKeyVaultUri: string;
    /** Name of the secret. */
    secretName: string;
  };
}

export interface BucketProps {
  /** Resource group of the NetApp account. Changing it replaces the bucket. */
  resourceGroup: string;
  /** Name of the NetApp account. Changing it replaces the bucket. */
  account: string;
  /** Name of the capacity pool. Changing it replaces the bucket. */
  pool: string;
  /** Name of the volume exposed by the bucket. Changing it replaces the bucket. */
  volume: string;
  /**
   * Bucket name: 3-63 lowercase letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the bucket.
   */
  name?: string;
  /**
   * Volume directory exposed as the bucket root. Changing it replaces the
   * bucket.
   * @default "/"
   */
  path?: string;
  /** File-system identity used for object access. */
  fileSystemUser: BucketFileSystemUser;
  /** Bucket server (S3 endpoint) settings. */
  server?: BucketServer;
  /**
   * Access granted through the bucket.
   * @default "ReadOnly"
   */
  permissions?: "ReadOnly" | "ReadWrite";
  /** Key Vault locations of the server certificate and credentials. */
  akvDetails?: BucketKeyVaultDetails;
}

export interface Bucket extends Resource<
  "Azure.NetApp.Bucket",
  BucketProps,
  {
    /** Name of the bucket. */
    bucketName: string;
    /** ARM resource ID of the bucket. */
    bucketId: string;
    /** Parent NetApp account. */
    account: string;
    /** Parent capacity pool. */
    pool: string;
    /** Parent volume. */
    volume: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Volume directory exposed as the bucket root. */
    path: string | undefined;
    /** Access granted through the bucket. */
    permissions: string | undefined;
    /** Credential status (`NoCredentialsSet`, `Active`, `CredentialsExpired`). */
    status: string | undefined;
    /** FQDN of the bucket server. */
    serverFqdn: string | undefined;
    /** IP address of the bucket server (S3 endpoint). */
    serverIpAddress: string | undefined;
    /** Expiry date of the server certificate. */
    certificateExpiryDate: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure NetApp Files bucket — S3-compatible object access to a volume
 * (or a directory inside it). Access keys are generated separately with
 * the `GenerateBucketCredentials` action. Preview feature, available in
 * selected regions.
 *
 * Buckets have no tags; Alchemy treats a bucket as owned when its volume
 * carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/azure-netapp-files/object-rest-api-introduction
 *
 * ### Creating a Bucket
 * **Example:** Read-only bucket over an NFS volume
 * ```typescript
 * const bucket = yield* Azure.NetApp.Bucket("objects", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   pool: pool.poolName,
 *   volume: volume.volumeName,
 *   fileSystemUser: { nfsUser: { userId: 1000, groupId: 1000 } },
 *   server: {
 *     fqdn: "objects.contoso.com",
 *     certificateObject: Redacted.make(certificatePemBase64),
 *   },
 * });
 * ```
 *
 * ### Write Access
 * **Example:** Read-write bucket on a sub-directory
 * ```typescript
 * const bucket = yield* Azure.NetApp.Bucket("uploads", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   pool: pool.poolName,
 *   volume: volume.volumeName,
 *   path: "/uploads",
 *   permissions: "ReadWrite",
 *   fileSystemUser: { nfsUser: { userId: 1000, groupId: 1000 } },
 *   server: { fqdn: "uploads.contoso.com" },
 *   akvDetails: {
 *     certificateAkvDetails: {
 *       certificateKeyVaultUri: vault.vaultUri,
 *       certificateName: "uploads",
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Bucket = Resource<Bucket>("Azure.NetApp.Bucket");

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  accountName: string;
  poolName: string;
  volumeName: string;
  bucketName: string;
}

const getBucket = (where: Where) =>
  orUndefinedIfNotFound(netapp.GetBucket(where));

const toAttrs = (
  where: Where,
  bucket: netapp.GetBucketResponse,
): Bucket["Attributes"] => ({
  bucketName: where.bucketName,
  bucketId: bucket.id ?? "",
  account: where.accountName,
  pool: where.poolName,
  volume: where.volumeName,
  resourceGroup: where.resourceGroupName,
  path: bucket.properties?.path,
  permissions: bucket.properties?.permissions,
  status: bucket.properties?.status,
  serverFqdn: bucket.properties?.server?.fqdn,
  serverIpAddress: bucket.properties?.server?.ipAddress,
  certificateExpiryDate: bucket.properties?.server?.certificateExpiryDate,
});

const toServer = (
  server: BucketServer | undefined,
  withCertificate: boolean,
): netapp.BucketServerPropertiesInput | undefined =>
  server === undefined
    ? undefined
    : {
        fqdn: server.fqdn,
        certificateObject:
          withCertificate && server.certificateObject
            ? Redacted.value(server.certificateObject)
            : undefined,
        onCertificateConflictAction: withCertificate
          ? (server.onCertificateConflictAction ?? "Update")
          : undefined,
      };

export const BucketProvider = () =>
  Provider.succeed(Bucket, {
    stables: [
      "bucketName",
      "bucketId",
      "account",
      "pool",
      "volume",
      "resourceGroup",
      "path",
    ],

    // Buckets are deleted with their volume; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account.toLowerCase() !== output.account.toLowerCase() ||
        news.pool.toLowerCase() !== output.pool.toLowerCase() ||
        news.volume.toLowerCase() !== output.volume.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.bucketName.toLowerCase()) ||
        (news.path ?? "/") !== (output.path ?? "/")
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const accountName = output?.account ?? olds?.account;
      const poolName = output?.pool ?? olds?.pool;
      const volumeName = output?.volume ?? olds?.volume;
      if (!resourceGroupName || !accountName || !poolName || !volumeName) {
        return undefined;
      }
      const where = {
        subscriptionId,
        resourceGroupName,
        accountName,
        poolName,
        volumeName,
        bucketName:
          output?.bucketName ??
          olds?.name ??
          (yield* createNetAppName(id, 63, true)),
      };
      const observed = yield* getBucket(where);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed);
      const parent = yield* getVolume(
        subscriptionId,
        resourceGroupName,
        accountName,
        poolName,
        volumeName,
      );
      return (yield* ownedByStage(parent?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.NetApp");
      const where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        accountName: news.account,
        poolName: news.pool,
        volumeName: news.volume,
        bucketName:
          news.name ??
          output?.bucketName ??
          (yield* createNetAppName(id, 63, true)),
      };
      const permissions = news.permissions ?? "ReadOnly";
      const get = getBucket(where);
      const waitReady = waitForProvisioned(
        `netapp bucket ${where.bucketName}`,
        get,
        (bucket) => bucket.properties?.provisioningState,
        LRO_BUDGET,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* whileBusy(
          netapp.BucketsCreateOrUpdate({
            ...where,
            properties: {
              path: news.path,
              fileSystemUser: news.fileSystemUser,
              server: toServer(news.server, true),
              permissions,
              akvDetails: news.akvDetails,
            },
          }),
        );
      }
      observed = yield* waitReady;

      // Sync identity, permissions, server FQDN, and Key Vault details
      // against observed state. The certificate is never read back, so it is
      // only re-sent when the server FQDN changes.
      const props = observed.properties;
      const changed: netapp.BucketPatchPropertiesInput = {};
      if (!matchesObserved(news.fileSystemUser, props?.fileSystemUser)) {
        changed.fileSystemUser = news.fileSystemUser;
      }
      if (props?.permissions !== permissions) changed.permissions = permissions;
      if (
        news.server !== undefined &&
        news.server.fqdn.toLowerCase() !== props?.server?.fqdn?.toLowerCase()
      ) {
        changed.server = toServer(news.server, true);
      }
      if (
        news.akvDetails !== undefined &&
        !matchesObserved(news.akvDetails, props?.akvDetails)
      ) {
        changed.akvDetails = news.akvDetails;
      }
      if (Object.keys(changed).length > 0) {
        yield* whileBusy(
          netapp.UpdateBucket({ ...where, properties: changed }),
        );
        observed = yield* waitReady;
      }

      return toAttrs(where, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        accountName: output.account,
        poolName: output.pool,
        volumeName: output.volume,
        bucketName: output.bucketName,
      };
      yield* whileBusy(ignoreNotFound(netapp.DeleteBucket(where)));
      yield* waitUntilGone(
        `netapp bucket ${output.bucketName}`,
        getBucket(where),
        LRO_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.NetApp.Volume", "Azure.Resources.ResourceGroup"],
    },
  });
