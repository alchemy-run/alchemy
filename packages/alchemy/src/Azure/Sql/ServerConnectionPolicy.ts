import * as sql from "@distilled.cloud/azure/sql";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isServerOwnedByStack, lower } from "./common.ts";
import { syncSetting } from "./setting.ts";

/** The policy is a singleton named `default`. */
const POLICY_NAME = "default";

export interface ServerConnectionPolicyProps {
  /** Resource group of the server. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the policy. */
  server: string;
  /**
   * How clients connect: `Redirect` connects straight to the database
   * node (lower latency, needs ports 11000-11999), `Proxy` routes every
   * packet through the gateway (port 1433 only), `Default` uses Redirect
   * inside Azure and Proxy from outside.
   */
  connectionType: "Default" | "Redirect" | "Proxy";
}

export interface ServerConnectionPolicy extends Resource<
  "Azure.Sql.ServerConnectionPolicy",
  ServerConnectionPolicyProps,
  {
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Observed connection type. */
    connectionType: string;
  },
  never,
  Providers
> {}

/**
 * The connection policy of an Azure SQL server — whether clients are
 * redirected to the database node or proxied through the gateway.
 *
 * This is a singleton setting that always exists on a server. Destroying
 * the resource resets it to `Default`.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/connectivity-architecture
 *
 * ### Choosing a Connection Type
 * **Example:** Proxy every connection through the gateway
 * ```typescript
 * yield* Azure.Sql.ServerConnectionPolicy("connection", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   connectionType: "Proxy",
 * });
 * ```
 *
 * **Example:** Redirect for lower latency
 * ```typescript
 * yield* Azure.Sql.ServerConnectionPolicy("connection", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   connectionType: "Redirect",
 * });
 * ```
 *
 * @resource
 */
export const ServerConnectionPolicy = Resource<ServerConnectionPolicy>(
  "Azure.Sql.ServerConnectionPolicy",
);

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetServerConnectionPolicy({
      subscriptionId,
      resourceGroupName,
      serverName,
      connectionPolicyName: POLICY_NAME,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  serverName: string,
  policy: sql.GetServerConnectionPolicyResponse,
): ServerConnectionPolicy["Attributes"] => ({
  policyId: policy.id ?? "",
  serverName,
  resourceGroup,
  connectionType: policy.properties?.connectionType ?? "Default",
});

const putPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
  connectionType: string,
) =>
  sql.ServerConnectionPoliciesCreateOrUpdate({
    subscriptionId,
    resourceGroupName,
    serverName,
    connectionPolicyName: POLICY_NAME,
    properties: { connectionType },
  });

export const ServerConnectionPolicyProvider = () =>
  Provider.succeed(ServerConnectionPolicy, {
    stables: ["policyId", "serverName", "resourceGroup"],

    // A per-server singleton setting; it disappears with its server.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.serverName ?? olds?.server;
      if (resourceGroup === undefined || serverName === undefined) {
        return undefined;
      }
      const observed = yield* getPolicy(
        subscriptionId,
        resourceGroup,
        serverName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serverName, observed);
      return output !== undefined ||
        (yield* isServerOwnedByStack(subscriptionId, resourceGroup, serverName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const { resourceGroup, server } = news;
      const fresh = yield* syncSetting({
        label: `sql connection policy on ${server}`,
        get: getPolicy(subscriptionId, resourceGroup, server),
        converged: (policy) =>
          lower(policy.properties?.connectionType) ===
          lower(news.connectionType),
        put: putPolicy(
          subscriptionId,
          resourceGroup,
          server,
          news.connectionType,
        ),
      });
      return toAttrs(resourceGroup, server, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const get = getPolicy(
        subscriptionId,
        output.resourceGroup,
        output.serverName,
      );
      if ((yield* get) === undefined) return;
      // The setting cannot be removed; reset it.
      yield* ignoreNotFound(
        syncSetting({
          label: `sql connection policy on ${output.serverName}`,
          get,
          converged: (observed) =>
            lower(observed.properties?.connectionType) === lower("Default"),
          put: putPolicy(
            subscriptionId,
            output.resourceGroup,
            output.serverName,
            "Default",
          ),
        }),
      );
    }),

    nuke: { singleton: true },
  });
