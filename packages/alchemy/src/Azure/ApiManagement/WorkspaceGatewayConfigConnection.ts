import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  stackAndStage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { sameName } from "./Common.ts";

export interface WorkspaceGatewayConfigConnectionProps {
  /** Resource group of the workspace gateway. Changing it replaces the connection. */
  resourceGroup: string;
  /** Name of the {@link WorkspaceGateway}. Changing it replaces the connection. */
  gatewayName: string;
  /**
   * Connection name, unique within the gateway. Changing it replaces the
   * connection.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /**
   * ARM resource ID of the {@link Workspace} served by the gateway
   * (`Workspace.workspaceId`). Changing it replaces the connection.
   * Workspace gateways serve workspaces on their generated
   * `defaultHostname`; custom hostnames are not supported.
   */
  workspaceId: string;
}

export interface WorkspaceGatewayConfigConnection extends Resource<
  "Azure.ApiManagement.WorkspaceGatewayConfigConnection",
  WorkspaceGatewayConfigConnectionProps,
  {
    /** Connection name. */
    connectionName: string;
    /** ARM resource ID of the connection. */
    connectionId: string;
    /** Name of the workspace gateway. */
    gatewayName: string;
    /** Resource group of the gateway. */
    resourceGroup: string;
    /** ARM resource ID of the connected workspace. */
    workspaceId: string;
    /** Default hostname the workspace is served on. */
    defaultHostname: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Connects an API Management {@link Workspace} to a {@link WorkspaceGateway}
 * so the gateway serves the workspace's APIs. Requires a Premium service;
 * the connection provisions asynchronously.
 *
 * @see https://learn.microsoft.com/azure/api-management/workspaces-overview#workspace-gateway
 *
 * ### Connecting a Workspace
 * **Example:** Serve a workspace on a dedicated gateway
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceGatewayConfigConnection("payments", {
 *   resourceGroup: group.resourceGroupName,
 *   gatewayName: gateway.gatewayName,
 *   workspaceId: workspace.workspaceId,
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceGatewayConfigConnection =
  Resource<WorkspaceGatewayConfigConnection>(
    "Azure.ApiManagement.WorkspaceGatewayConfigConnection",
  );

/** Connection names: 1-30 characters, letters, digits, and hyphens. */
const createConnectionName = (id: string) =>
  createPhysicalName({ id, maxLength: 30, lowercase: true });

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  gatewayName: string,
  configConnectionName: string,
) =>
  orUndefinedIfNotFound(
    apim.GetApiGatewayConfigConnection({
      subscriptionId,
      resourceGroupName,
      gatewayName,
      configConnectionName,
    }),
  );

/** The connection carries no tags; ownership follows the parent gateway. */
const isGatewayOwned = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  gatewayName: string,
) {
  const gateway = yield* orUndefinedIfNotFound(
    apim.GetApiGateway({ subscriptionId, resourceGroupName, gatewayName }),
  );
  const { stack, stage } = yield* stackAndStage;
  return (
    gateway?.tags?.["alchemy::stack"] === stack &&
    gateway?.tags?.["alchemy::stage"] === stage
  );
});

const toAttrs = (
  resourceGroup: string,
  gatewayName: string,
  name: string,
  connection: apim.GetApiGatewayConfigConnectionResponse,
): WorkspaceGatewayConfigConnection["Attributes"] => ({
  connectionName: name,
  connectionId: connection.id ?? "",
  gatewayName,
  resourceGroup,
  workspaceId: connection.properties.sourceId ?? "",
  defaultHostname: connection.properties.defaultHostname,
});

export const WorkspaceGatewayConfigConnectionProvider = () =>
  Provider.succeed(WorkspaceGatewayConfigConnection, {
    stables: ["connectionName", "connectionId", "gatewayName", "resourceGroup"],

    // Connections live inside a gateway; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.gatewayName, output.gatewayName) ||
        (news.name !== undefined &&
          !sameName(news.name, output.connectionName)) ||
        (output.workspaceId !== "" &&
          !sameName(news.workspaceId, output.workspaceId))
      ) {
        // A kept explicit name keeps the path: delete the old connection
        // first so its delete cannot remove the replacement.
        return news.name !== undefined &&
          sameName(news.name, output.connectionName)
          ? ({ action: "replace", deleteFirst: true } as const)
          : ({ action: "replace" } as const);
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const gatewayName = output?.gatewayName ?? olds?.gatewayName;
      if (resourceGroup === undefined || gatewayName === undefined) {
        return undefined;
      }
      const name =
        output?.connectionName ?? olds?.name ?? (yield* createConnectionName(id));
      const observed = yield* getConnection(
        subscriptionId,
        resourceGroup,
        gatewayName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, gatewayName, name, observed);
      return (yield* isGatewayOwned(subscriptionId, resourceGroup, gatewayName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiManagement");
      const { resourceGroup, gatewayName } = news;
      const name =
        news.name ?? output?.connectionName ?? (yield* createConnectionName(id));
      const get = getConnection(
        subscriptionId,
        resourceGroup,
        gatewayName,
        name,
      );

      // Observe, then create (or re-point a connection left on another
      // workspace) with one upsert.
      const observed = yield* get;
      const inSync =
        observed !== undefined &&
        sameName(observed.properties.sourceId, news.workspaceId);
      if (!inSync) {
        yield* apim.ApiGatewayConfigConnectionCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          gatewayName,
          configConnectionName: name,
          properties: { sourceId: news.workspaceId },
        }).pipe(
          // A workspace created moments earlier is not yet visible to the
          // gateway control plane, which answers with an empty 500.
          Effect.retry({
            while: (e) => e._tag === "InternalServerError",
            schedule: Schedule.spaced("15 seconds"),
            times: 12,
          }),
        );
      }
      const current = yield* waitForProvisioned(
        `workspace gateway connection ${name}`,
        get,
        (connection) => connection.properties.provisioningState,
        { interval: "15 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, gatewayName, name, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        apim.DeleteApiGatewayConfigConnection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          gatewayName: output.gatewayName,
          configConnectionName: output.connectionName,
        }),
      );
      yield* waitUntilGone(
        `workspace gateway connection ${output.connectionName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.gatewayName,
          output.connectionName,
        ),
        { interval: "15 seconds", times: 60 },
      );
    }),
  });
