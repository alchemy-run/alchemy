import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { armTags, createChildName, inputFields, sameArm, sameValue } from "./Common.ts";

export type DatastoreType =
  | "AzureBlob"
  | "AzureFile"
  | "AzureDataLakeGen1"
  | "AzureDataLakeGen2"
  | "OneLake";

export interface DatastoreCredentials {
  /**
   * Credential type. `None` uses identity-based access (the caller's or the
   * workspace's identity).
   */
  credentialsType: "None" | "AccountKey" | "Sas" | "ServicePrincipal" | "Certificate";
  /**
   * Secrets for the credential type (write-only): `AccountKey` →
   * `{ secretsType: "AccountKey", key }`, `Sas` →
   * `{ secretsType: "Sas", sasToken }`, `ServicePrincipal` →
   * `{ secretsType: "ServicePrincipal", clientSecret }`.
   */
  secrets?: Record<string, unknown>;
  /** Client ID (`ServicePrincipal`, `Certificate`). */
  clientId?: string;
  /** Tenant ID (`ServicePrincipal`, `Certificate`). */
  tenantId?: string;
}

export interface DatastoreProps {
  /** Resource group of the workspace. Changing it replaces the datastore. */
  resourceGroup: string;
  /** Workspace that owns the datastore. Changing it replaces the datastore. */
  workspace: string;
  /**
   * Datastore name: lowercase letters, digits, and underscores. If omitted,
   * a unique name is generated from the logical ID. Changing it replaces
   * the datastore.
   * @default a unique name generated from the logical ID
   */
  name?: string;
  /**
   * Storage service the datastore points at. Changing it replaces the
   * datastore.
   * @default "AzureBlob"
   */
  datastoreType?: DatastoreType;
  /**
   * Storage account name (`AzureBlob`, `AzureFile`, `AzureDataLakeGen2`).
   * Changing it replaces the datastore.
   * @default none
   */
  accountName?: string;
  /**
   * Blob container name (`AzureBlob`). Changing it replaces the datastore.
   * @default none
   */
  containerName?: string;
  /**
   * File share name (`AzureFile`). Changing it replaces the datastore.
   * @default none
   */
  fileShareName?: string;
  /**
   * File system name (`AzureDataLakeGen2`). Changing it replaces the datastore.
   * @default none
   */
  filesystem?: string;
  /**
   * Data Lake Gen1 store name (`AzureDataLakeGen1`). Changing it replaces the datastore.
   * @default none
   */
  storeName?: string;
  /**
   * Storage endpoint suffix. Changing it replaces the datastore.
   * @default "core.windows.net"
   */
  endpoint?: string;
  /**
   * Protocol used to reach the storage. Changing it replaces the datastore.
   * @default "https"
   */
  protocol?: string;
  /**
   * Credentials the datastore uses. Changing them replaces the datastore.
   * @default { credentialsType: "None" }
   */
  credentials?: DatastoreCredentials;
  /**
   * Which identity the workspace uses for data access (`None`,
   * `WorkspaceSystemAssignedIdentity`, `WorkspaceUserAssignedIdentity`).
   * Changing it replaces the datastore.
   * @default "None"
   */
  serviceDataAccessAuthIdentity?: string;
  /**
   * Description of the datastore. Changing it replaces the datastore.
   * @default none
   */
  description?: string;
  /**
   * Skip validating that the workspace can reach the storage with the
   * credentials.
   * @default false
   */
  skipValidation?: boolean;
  /**
   * User tags (stored in the datastore body). Alchemy ownership tags are
   * merged in automatically. Changing them replaces the datastore.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface Datastore extends Resource<
  "Azure.MachineLearning.Datastore",
  DatastoreProps,
  {
    /** Name of the datastore. */
    datastoreName: string;
    /** ARM resource ID of the datastore. */
    datastoreId: string;
    /** Workspace that owns the datastore. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Storage service the datastore points at. */
    datastoreType: string;
    /** Storage account name, when applicable. */
    accountName: string | undefined;
    /** Whether this is the workspace's default datastore. */
    isDefault: boolean;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A datastore in an Azure Machine Learning workspace — a named reference
 * to a blob container, file share, or Data Lake file system that jobs and
 * data assets read from and write to.
 *
 * ARM type: `Microsoft.MachineLearningServices/workspaces/datastores`.
 * See the [Azure documentation](https://learn.microsoft.com/azure/machine-learning/how-to-datastore).
 *
 * Azure ignores updates to an existing datastore, so every change
 * replaces it (datastores are only pointers; no data moves). The
 * workspace's system datastores (`workspaceblobstore`, ...) are created by
 * Azure; manage only your own datastores with this resource.
 *
 * :::caution
 * Changing `resourceGroup`, `workspace`, `name`, `datastoreType`,
 * `accountName`, `containerName`, `fileShareName`, `filesystem`, `storeName`,
 * `endpoint`, `protocol`, `credentials`, `serviceDataAccessAuthIdentity`,
 * `description`, or `tags` replaces the datastore.
 * :::
 *
 * ### Creating a Datastore
 * **Example:** Identity-based blob datastore
 * ```typescript
 * const storage = yield* Azure.Storage.StorageAccount("artifacts");
 * const vault = yield* Azure.KeyVault.Vault("secrets", { enableRbacAuthorization: false });
 * const hub = yield* Azure.MachineLearning.Workspace("hub", {
 *   kind: "Hub",
 *   storageAccount: storage.storageAccountId,
 *   keyVault: vault.vaultId,
 * });
 * const workspace = yield* Azure.MachineLearning.Workspace("project", {
 *   kind: "Project",
 *   hubResourceId: hub.workspaceId,
 * });
 * const container = yield* Azure.Storage.BlobContainer("training", {
 *   storageAccount: storage.storageAccountName,
 * });
 * const datastore = yield* Azure.MachineLearning.Datastore("training", {
 *   workspace: workspace.workspaceName,
 *   accountName: storage.storageAccountName,
 *   containerName: container.containerName,
 * });
 * ```
 *
 * **Example:** Data Lake Gen2 datastore with a service principal
 * ```typescript
 * const datastore = yield* Azure.MachineLearning.Datastore("lake", {
 *   workspace: workspace.workspaceName,
 *   datastoreType: "AzureDataLakeGen2",
 *   accountName: lake.storageAccountName,
 *   filesystem: "raw",
 *   credentials: {
 *     credentialsType: "ServicePrincipal",
 *     clientId,
 *     tenantId,
 *     secrets: { secretsType: "ServicePrincipal", clientSecret },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Datastore = GroupedResource<Datastore>("Azure.MachineLearning.Datastore");

const getDatastore = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    ml.GetDatastore({ subscriptionId, resourceGroupName, workspaceName, name }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  datastore: ml.GetDatastoreResponse,
): Datastore["Attributes"] => ({
  datastoreName: name,
  datastoreId: datastore.id ?? "",
  workspace,
  resourceGroup,
  datastoreType: datastore.properties.datastoreType,
  accountName: datastore.properties.accountName,
  isDefault: datastore.properties.isDefault ?? false,
  tags: userTags(armTags(datastore.properties.tags)),
});

const location = (news: DatastoreProps) => ({
  accountName: news.accountName,
  containerName: news.containerName,
  fileShareName: news.fileShareName,
  filesystem: news.filesystem,
  storeName: news.storeName,
});

export const DatastoreProvider = () =>
  Provider.succeed(Datastore, {
    stables: ["datastoreName", "datastoreId", "workspace", "resourceGroup"],

    // Datastores are deleted with their workspace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // Parent names are stable upstream; an unresolved one means the
      // parent is being replaced.
      const fields = inputFields(news);
      if (
        fields === undefined ||
        !isResolved(fields.resourceGroup) ||
        !isResolved(fields.workspace) ||
        !isResolved(fields.accountName) ||
        !isResolved(fields.containerName)
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.workspace, output.workspace) ||
        (news.name !== undefined && news.name !== output.datastoreName) ||
        !sameArm(news.datastoreType ?? "AzureBlob", output.datastoreType) ||
        (olds !== undefined &&
          (!sameValue(location(news), location(olds)) ||
            (news.endpoint ?? "core.windows.net") !== (olds.endpoint ?? "core.windows.net") ||
            (news.protocol ?? "https") !== (olds.protocol ?? "https") ||
            news.description !== olds.description ||
            news.serviceDataAccessAuthIdentity !== olds.serviceDataAccessAuthIdentity ||
            !sameValue(news.credentials, olds.credentials) ||
            !sameValue(news.tags ?? {}, olds.tags ?? {})))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const name =
        output?.datastoreName ??
        olds?.name ??
        (yield* createChildName(id, 64, { underscores: true }));
      const observed = yield* getDatastore(subscriptionId, resourceGroup, workspace, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      return (yield* isOwned(id, armTags(observed.properties.tags))) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.MachineLearningServices");
      const { resourceGroup, workspace } = news;
      const name =
        news.name ??
        output?.datastoreName ??
        (yield* createChildName(id, 64, { underscores: true }));
      const tags = yield* desiredTags(id, news.tags);
      const credentials = news.credentials ?? { credentialsType: "None" };
      const get = getDatastore(subscriptionId, resourceGroup, workspace, name);

      // Observe.
      const observed = yield* get;

      // Ensure. A PUT on an existing datastore returns 200 but leaves it
      // unchanged, so every change replaces the datastore (see diff) and
      // the PUT is only sent when it is missing.
      if (observed === undefined) {
        yield* ml.DatastoresCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          name,
          skipValidation: news.skipValidation,
          properties: {
            datastoreType: news.datastoreType ?? "AzureBlob",
            ...location(news),
            endpoint: news.endpoint ?? "core.windows.net",
            protocol: news.protocol ?? "https",
            credentials,
            serviceDataAccessAuthIdentity: news.serviceDataAccessAuthIdentity,
            description: news.description,
            tags,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `machine learning datastore ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, workspace, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        ml.DeleteDatastore({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          name: output.datastoreName,
        }),
      );
      yield* waitUntilGone(
        `machine learning datastore ${output.datastoreName}`,
        getDatastore(subscriptionId, output.resourceGroup, output.workspace, output.datastoreName),
      );
    }),

    nuke: { dependsOn: ["Azure.MachineLearning.Workspace"] },
  });
