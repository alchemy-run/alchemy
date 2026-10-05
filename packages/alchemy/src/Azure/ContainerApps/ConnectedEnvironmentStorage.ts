import * as app from "@distilled.cloud/azure/app";
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
  createContainerAppsName,
  fingerprint,
  isConnectedEnvironmentOwnedByStack,
  lower,
  matchesDesired,
  reveal,
} from "./common.ts";
import type { EnvironmentStorageAzureFile } from "./EnvironmentStorage.ts";

export interface ConnectedEnvironmentStorageProps {
  /** Resource group of the connected environment. Changing it replaces the storage. */
  resourceGroup: string;
  /** Name of the connected environment. Changing it replaces the storage. */
  environment: string;
  /**
   * Storage name that apps reference in `volumes[].storageName`: lowercase
   * letters, digits, and hyphens. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the storage.
   */
  name?: string;
  /** SMB Azure Files share to mount. */
  azureFile: EnvironmentStorageAzureFile;
}

export interface ConnectedEnvironmentStorage extends Resource<
  "Azure.ContainerApps.ConnectedEnvironmentStorage",
  ConnectedEnvironmentStorageProps,
  {
    /** Name of the storage (an app volume's `storageName`). */
    storageName: string;
    /** ARM resource ID of the storage. */
    storageId: string;
    /** Name of the connected environment. */
    environment: string;
    /** Resource group of the connected environment. */
    resourceGroup: string;
    /** Mount access mode. */
    accessMode: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Files share registered with a Container Apps connected (Azure
 * Arc) environment (`Microsoft.App/connectedEnvironments/storages`), for
 * mounting as an app volume.
 *
 * Storages cannot be tagged; Alchemy treats a storage as owned when its
 * environment is owned by the same stack and stage.
 *
 * ### Mounting Azure Files
 * **Example:** Share mounted with the account key
 * ```typescript
 * const files = yield* Azure.ContainerApps.ConnectedEnvironmentStorage("files", {
 *   resourceGroup: group.resourceGroupName,
 *   environment: arcEnv.environmentName,
 *   azureFile: {
 *     accountName: account.storageAccountName,
 *     accountKey: Redacted.make(accountKey),
 *     shareName: share.shareName,
 *     accessMode: "ReadWrite",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const ConnectedEnvironmentStorage =
  Resource<ConnectedEnvironmentStorage>(
    "Azure.ContainerApps.ConnectedEnvironmentStorage",
  );

const createStorageName = (id: string) => createContainerAppsName(id, 32);

const getStorage = (
  subscriptionId: string,
  resourceGroupName: string,
  connectedEnvironmentName: string,
  storageName: string,
) =>
  orUndefinedIfNotFound(
    app.GetConnectedEnvironmentsStorage({
      subscriptionId,
      resourceGroupName,
      connectedEnvironmentName,
      storageName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  environment: string,
  name: string,
  observed: app.GetConnectedEnvironmentsStorageResponse,
): ConnectedEnvironmentStorage["Attributes"] => ({
  storageName: name,
  storageId: observed.id ?? "",
  environment,
  resourceGroup,
  accessMode: observed.properties?.azureFile?.accessMode,
});

const toProperties = (
  props: ConnectedEnvironmentStorageProps,
): app.ConnectedEnvironmentStoragePropertiesInput => ({
  azureFile: {
    accountName: props.azureFile.accountName,
    accountKey: reveal(props.azureFile.accountKey),
    shareName: props.azureFile.shareName,
    accessMode: props.azureFile.accessMode ?? "ReadWrite",
  },
});

export const ConnectedEnvironmentStorageProvider = () =>
  Provider.succeed(ConnectedEnvironmentStorage, {
    stables: ["storageName", "storageId", "environment", "resourceGroup"],

    // Lives inside a connected environment; nuke removes it with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.environment !== output.environment ||
        (news.name !== undefined && news.name !== output.storageName)
      ) {
        return { action: "replace" } as const;
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
      return (yield* isConnectedEnvironmentOwnedByStack(
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
      if (
        observed === undefined ||
        !matchesDesired(
          { azureFile: { ...properties.azureFile, accountKey: undefined } },
          observed.properties,
        ) ||
        (olds !== undefined &&
          fingerprint(properties) !== fingerprint(toProperties(olds)))
      ) {
        yield* app.ConnectedEnvironmentsStoragesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          connectedEnvironmentName: environment,
          storageName: name,
          properties,
        });
      }

      const fresh = yield* waitForProvisioned(
        `connected environment storage ${name}`,
        get,
        (storage) => storage.properties?.provisioningState,
        { interval: "5 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, environment, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        app.DeleteConnectedEnvironmentsStorage({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          connectedEnvironmentName: output.environment,
          storageName: output.storageName,
        }),
      );
      yield* waitUntilGone(
        `connected environment storage ${output.storageName}`,
        getStorage(
          subscriptionId,
          output.resourceGroup,
          output.environment,
          output.storageName,
        ),
      );
    }),
  });
