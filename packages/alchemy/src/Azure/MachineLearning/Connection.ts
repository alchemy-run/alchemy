import * as ml from "@distilled.cloud/azure/machinelearningservices";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
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
import { createChildName, sameArm, sameValue } from "./Common.ts";

export type ConnectionAuthType =
  | "None"
  | "ApiKey"
  | "AccessKey"
  | "AccountKey"
  | "PAT"
  | "ManagedIdentity"
  | "ServicePrincipal"
  | "SAS"
  | "UsernamePassword"
  | "CustomKeys"
  | "OAuth2"
  | "AAD"
  | (string & {});

export interface ConnectionProps {
  /** Resource group of the workspace. Changing it replaces the connection. */
  resourceGroup: string;
  /** Workspace that owns the connection. Changing it replaces the connection. */
  workspace: string;
  /**
   * Connection name: letters, digits, `-`, and `_`. If omitted, a unique
   * name is generated from the logical ID. Changing it replaces the
   * connection.
   */
  name?: string;
  /**
   * Authentication type; it decides the shape of `credentials`. Changing it
   * replaces the connection.
   */
  authType: ConnectionAuthType;
  /**
   * Connection category, e.g. `AzureOpenAI`, `CognitiveSearch`,
   * `AzureBlob`, `ContainerRegistry`, `CustomKeys`, `ApiKey`. Changing it
   * replaces the connection.
   */
  category: string;
  /** Target URL or ARM ID of the connected service. */
  target?: string;
  /**
   * Credentials for `authType` (write-only): `ApiKey` → `{ key }`,
   * `CustomKeys` → `{ keys: { name: value } }`, `AccessKey` →
   * `{ accessKeyId, secretAccessKey }`, `ServicePrincipal` →
   * `{ clientId, clientSecret, tenantId }`, `PAT` → `{ pat }`. Azure never
   * returns them, so changes are detected against the previous deploy.
   */
  credentials?: Record<string, unknown>;
  /**
   * Category-specific metadata (e.g. `ApiType`, `ResourceId`). Alchemy
   * ownership markers (`alchemy::stack`, `alchemy::stage`, `alchemy::id`)
   * are merged in.
   */
  metadata?: Record<string, string>;
  /**
   * Share the connection with every workspace user.
   * @default true
   */
  isSharedToAll?: boolean;
  /** Expiry of the credentials, as an ISO 8601 timestamp. */
  expiryTime?: string;
  /** Authenticate with the workspace's managed identity instead of `credentials`. */
  useWorkspaceManagedIdentity?: boolean;
}

export interface Connection extends Resource<
  "Azure.MachineLearning.Connection",
  ConnectionProps,
  {
    /** Name of the connection. */
    connectionName: string;
    /** ARM resource ID of the connection. */
    connectionId: string;
    /** Workspace that owns the connection. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Authentication type. */
    authType: string;
    /** Connection category. */
    category: string;
    /** Target of the connection. */
    target: string | undefined;
    /** Category group Azure assigns (e.g. `AzureAI`, `ServicesAndApps`). */
    group: string | undefined;
    /** User metadata (Alchemy ownership markers stripped). */
    metadata: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A workspace connection in Azure Machine Learning / Azure AI Foundry — a
 * named, credential-bearing link to an external service (Azure OpenAI, AI
 * Search, a storage account, a container registry, any API key).
 *
 * Connections cannot be tagged, so Alchemy records ownership in the
 * connection's `metadata`. Credentials are write-only.
 *
 * @see https://learn.microsoft.com/azure/machine-learning/how-to-connection
 *
 * ### Creating a Connection
 * **Example:** API key connection
 * ```typescript
 * const connection = yield* Azure.MachineLearning.Connection("search", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   category: "ApiKey",
 *   authType: "ApiKey",
 *   target: "https://api.example.com",
 *   credentials: { key: apiKey },
 * });
 * ```
 *
 * **Example:** Custom keys connection
 * ```typescript
 * const connection = yield* Azure.MachineLearning.Connection("vendor", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   category: "CustomKeys",
 *   authType: "CustomKeys",
 *   target: "https://vendor.example.com",
 *   credentials: { keys: { token: vendorToken } },
 * });
 * ```
 *
 * @resource
 */
export const Connection = Resource<Connection>(
  "Azure.MachineLearning.Connection",
);

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  connectionName: string,
) =>
  orUndefinedIfNotFound(
    ml.GetWorkspaceConnection({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      connectionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  connection: ml.GetWorkspaceConnectionResponse,
): Connection["Attributes"] => ({
  connectionName: name,
  connectionId: connection.id ?? "",
  workspace,
  resourceGroup,
  authType: connection.properties.authType,
  category: connection.properties.category ?? "",
  target: connection.properties.target,
  group: connection.properties.group,
  metadata: userTags(connection.properties.metadata),
});

export const ConnectionProvider = () =>
  Provider.succeed(Connection, {
    stables: ["connectionName", "connectionId", "workspace", "resourceGroup"],

    // Connections are deleted with their workspace.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // Parent names are stable upstream; an unresolved one means the
      // parent is being replaced.
      if (!isResolved(news.resourceGroup) || !isResolved(news.workspace)) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.workspace, output.workspace) ||
        (news.name !== undefined && news.name !== output.connectionName) ||
        !sameArm(news.authType, output.authType) ||
        !sameArm(news.category, output.category)
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
        output?.connectionName ??
        olds?.name ??
        (yield* createChildName(id, 64));
      const observed = yield* getConnection(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      return (yield* isOwned(id, observed.properties.metadata))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.MachineLearningServices",
      );
      const { resourceGroup, workspace } = news;
      const name =
        news.name ?? output?.connectionName ?? (yield* createChildName(id, 64));
      const metadata = yield* desiredTags(id, news.metadata);
      const isSharedToAll = news.isSharedToAll ?? true;
      const get = getConnection(subscriptionId, resourceGroup, workspace, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync. The PUT is a synchronous upsert; send it when the
      // connection is missing, an observed field drifted, or the
      // write-only credentials changed since the last deploy (always on
      // adoption, where there is no previous deploy to compare).
      const props = observed?.properties;
      const drifted =
        props === undefined ||
        (news.target !== undefined && props.target !== news.target) ||
        (props.isSharedToAll ?? true) !== isSharedToAll ||
        (news.expiryTime !== undefined &&
          props.expiryTime !== news.expiryTime) ||
        (news.useWorkspaceManagedIdentity !== undefined &&
          props.useWorkspaceManagedIdentity !==
            news.useWorkspaceManagedIdentity) ||
        tagsDiffer(props.metadata, metadata) ||
        olds === undefined ||
        !sameValue(olds.credentials, news.credentials);
      if (drifted) {
        yield* ml.CreateWorkspaceConnection({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          connectionName: name,
          properties: {
            authType: news.authType,
            category: news.category,
            target: news.target,
            credentials: news.credentials,
            metadata,
            isSharedToAll,
            expiryTime: news.expiryTime,
            useWorkspaceManagedIdentity: news.useWorkspaceManagedIdentity,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `machine learning connection ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, workspace, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        ml.DeleteWorkspaceConnection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          connectionName: output.connectionName,
        }),
      );
      yield* waitUntilGone(
        `machine learning connection ${output.connectionName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.connectionName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.MachineLearning.Workspace"] },
  });
