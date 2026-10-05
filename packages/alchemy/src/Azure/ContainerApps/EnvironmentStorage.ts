import * as app from "@distilled.cloud/azure/app";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
  createContainerAppsName,
  fingerprint,
  isEnvironmentOwnedByStack,
  lower,
  matchesDesired,
  reveal,
} from "./common.ts";

/** An SMB Azure Files share mounted with the storage account key. */
export interface EnvironmentStorageAzureFile {
  /** Storage account name. Changing it replaces the storage. */
  accountName: string;
  /** Storage account access key. Updated in place (e.g. key rotation). */
  accountKey: string | Redacted.Redacted<string>;
  /** File share name. Changing it replaces the storage. */
  shareName: string;
  /**
   * Mount access mode. Changing it replaces the storage.
   * @default "ReadWrite"
   */
  accessMode?: "ReadOnly" | "ReadWrite";
}

/** An NFS Azure Files share (premium `FileStorage` account, VNet environment). */
export interface EnvironmentStorageNfsAzureFile {
  /** NFS server, e.g. `{account}.file.core.windows.net`. Changing it replaces the storage. */
  server: string;
  /** Share path, e.g. `/{account}/{share}`. Changing it replaces the storage. */
  shareName: string;
  /**
   * Mount access mode. Changing it replaces the storage.
   * @default "ReadWrite"
   */
  accessMode?: "ReadOnly" | "ReadWrite";
}

export interface EnvironmentStorageProps {
  /** Resource group of the environment. Changing it replaces the storage. */
  resourceGroup: string;
  /** Name of the Container Apps environment. Changing it replaces the storage. */
  environment: string;
  /**
   * Storage name that apps reference in `volumes[].storageName`: lowercase
   * letters, digits, and hyphens. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the storage.
   */
  name?: string;
  /**
   * SMB Azure Files share. Exactly one of `azureFile` and `nfsAzureFile`
   * is required; switching between them replaces the storage.
   */
  azureFile?: EnvironmentStorageAzureFile;
  /** NFS Azure Files share. */
  nfsAzureFile?: EnvironmentStorageNfsAzureFile;
}

export interface EnvironmentStorage extends Resource<
  "Azure.ContainerApps.EnvironmentStorage",
  EnvironmentStorageProps,
  {
    /** Storage name; reference it from an app volume's `storageName`. */
    storageName: string;
    /** ARM resource ID of the storage. */
    storageId: string;
    /** Name of the environment that holds the storage. */
    environment: string;
    /** Resource group of the environment. */
    resourceGroup: string;
    /** `AzureFile` or `NfsAzureFile`, for an app volume's `storageType`. */
    storageType: "AzureFile" | "NfsAzureFile";
    /** Mount access mode. */
    accessMode: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Files share registered with a Container Apps environment
 * (`Microsoft.App/managedEnvironments/storages`), so apps and jobs can mount
 * it as a volume.
 *
 * Storages cannot be tagged; Alchemy treats a storage as owned when its
 * environment is owned by the same stack and stage.
 *
 * @see https://learn.microsoft.com/azure/container-apps/storage-mounts
 *
 * ### Mounting Azure Files
 * **Example:** Register a file share and mount it in an app
 * ```typescript
 * const storage = yield* Azure.ContainerApps.EnvironmentStorage("files", {
 *   resourceGroup: group.resourceGroupName,
 *   environment: env.environmentName,
 *   azureFile: {
 *     accountName: account.storageAccountName,
 *     accountKey: Redacted.make(accountKey),
 *     shareName: share.shareName,
 *     accessMode: "ReadWrite",
 *   },
 * });
 * const api = yield* Azure.ContainerApps.ContainerApp("api", {
 *   resourceGroup: group.resourceGroupName,
 *   environmentId: env.environmentId,
 *   template: {
 *     containers: [
 *       { name: "api", image, volumeMounts: [{ volumeName: "files", mountPath: "/data" }] },
 *     ],
 *     volumes: [
 *       { name: "files", storageType: "AzureFile", storageName: storage.storageName },
 *     ],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const EnvironmentStorage = Resource<EnvironmentStorage>(
  "Azure.ContainerApps.EnvironmentStorage",
);

const createStorageName = (id: string) => createContainerAppsName(id, 32);

const getStorage = (
  subscriptionId: string,
  resourceGroupName: string,
  environmentName: string,
  storageName: string,
) =>
  orUndefinedIfNotFound(
    app.GetManagedEnvironmentsStorage({
      subscriptionId,
      resourceGroupName,
      environmentName,
      storageName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  environment: string,
  name: string,
  observed: app.GetManagedEnvironmentsStorageResponse,
): EnvironmentStorage["Attributes"] => {
  const nfs = observed.properties?.nfsAzureFile;
  return {
    storageName: name,
    storageId: observed.id ?? "",
    environment,
    resourceGroup,
    storageType: nfs?.shareName !== undefined ? "NfsAzureFile" : "AzureFile",
    accessMode: nfs?.accessMode ?? observed.properties?.azureFile?.accessMode,
  };
};

/** The desired `properties` body (account key revealed). */
const toProperties = (
  props: EnvironmentStorageProps,
): app.ManagedEnvironmentStorageProperties => ({
  azureFile:
    props.azureFile === undefined
      ? undefined
      : {
          accountName: props.azureFile.accountName,
          accountKey: reveal(props.azureFile.accountKey),
          shareName: props.azureFile.shareName,
          accessMode: props.azureFile.accessMode ?? "ReadWrite",
        },
  nfsAzureFile:
    props.nfsAzureFile === undefined
      ? undefined
      : {
          ...props.nfsAzureFile,
          accessMode: props.nfsAzureFile.accessMode ?? "ReadWrite",
        },
});

export const EnvironmentStorageProvider = () =>
  Provider.succeed(EnvironmentStorage, {
    stables: ["storageName", "storageId", "environment", "resourceGroup"],

    // Storages live inside an environment; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      // ARM rejects changes to the account/server, share name, and access
      // mode ("Only Azure File authentication settings can be updated").
      const smbChanged =
        news.azureFile !== undefined &&
        olds?.azureFile !== undefined &&
        (lower(news.azureFile.accountName) !==
          lower(olds.azureFile.accountName) ||
          news.azureFile.shareName !== olds.azureFile.shareName ||
          (news.azureFile.accessMode ?? "ReadWrite") !==
            (olds.azureFile.accessMode ?? "ReadWrite"));
      const nfsChanged =
        news.nfsAzureFile !== undefined &&
        olds?.nfsAzureFile !== undefined &&
        (lower(news.nfsAzureFile.server) !== lower(olds.nfsAzureFile.server) ||
          news.nfsAzureFile.shareName !== olds.nfsAzureFile.shareName ||
          (news.nfsAzureFile.accessMode ?? "ReadWrite") !==
            (olds.nfsAzureFile.accessMode ?? "ReadWrite"));
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.environment !== output.environment ||
        (news.name !== undefined && news.name !== output.storageName) ||
        (news.nfsAzureFile !== undefined ? "NfsAzureFile" : "AzureFile") !==
          output.storageType ||
        smbChanged ||
        nfsChanged
      ) {
        // A fixed name cannot coexist with its replacement.
        return {
          action: "replace",
          deleteFirst: news.name !== undefined,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const environment = output?.environment ?? olds?.environment;
      if (resourceGroup === undefined || environment === undefined) {
        return undefined;
      }
      const name =
        output?.storageName ?? olds?.name ?? (yield* createStorageName(id));
      const observed = yield* getStorage(
        subscriptionId,
        resourceGroup,
        environment,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, environment, name, observed);
      // Storages cannot be tagged; ownership follows the environment.
      return (yield* isEnvironmentOwnedByStack(
        subscriptionId,
        resourceGroup,
        environment,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const { resourceGroup, environment } = news;
      const name =
        news.name ?? output?.storageName ?? (yield* createStorageName(id));
      const properties = toProperties(news);
      const get = getStorage(subscriptionId, resourceGroup, environment, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync. ARM never returns the account key, so a rotated key
      // is detected against the previous props.
      const observable = {
        ...properties,
        azureFile:
          properties.azureFile === undefined
            ? undefined
            : { ...properties.azureFile, accountKey: undefined },
      };
      if (
        observed === undefined ||
        !matchesDesired(observable, observed.properties) ||
        (olds !== undefined &&
          fingerprint(properties) !== fingerprint(toProperties(olds)))
      ) {
        yield* app.ManagedEnvironmentsStoragesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          environmentName: environment,
          storageName: name,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(
        `environment storage ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, environment, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteManagedEnvironmentsStorage({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          environmentName: output.environment,
          storageName: output.storageName,
        }),
      );
      yield* waitUntilGone(
        `environment storage ${output.storageName}`,
        getStorage(
          subscriptionId,
          output.resourceGroup,
          output.environment,
          output.storageName,
        ),
      );
    }),
  });
