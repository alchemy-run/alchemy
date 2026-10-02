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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createChildName, isServerOwnedByStack, lower } from "./common.ts";
import {
  jobAgentPath,
  type JobAgentScope,
  retryWhileAgentBusy,
} from "./setting.ts";

export interface JobPrivateEndpointProps {
  /** Resource group of the server. Changing it replaces the private endpoint. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the private endpoint. */
  server: string;
  /** Name of the elastic job agent. Changing it replaces the private endpoint. */
  jobAgent: string;
  /**
   * Name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the private endpoint.
   */
  name?: string;
  /**
   * ARM ID of the SQL server the agent reaches over the managed private
   * endpoint. Approve the resulting pending connection on that server
   * (e.g. with `Azure.Sql.PrivateEndpointConnection`). Changing it
   * replaces the endpoint.
   */
  targetServerId: string;
}

export interface JobPrivateEndpoint extends Resource<
  "Azure.Sql.JobPrivateEndpoint",
  JobPrivateEndpointProps,
  {
    /** Name of the private endpoint. */
    privateEndpointName: string;
    /** ARM resource ID of the private endpoint. */
    jobPrivateEndpointId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Name of the elastic job agent. */
    jobAgentName: string;
    /** ARM ID of the target SQL server. */
    targetServerId: string;
    /** ARM ID of the managed private endpoint Azure created. */
    privateEndpointId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A service-managed private endpoint of an elastic job agent — lets the
 * agent reach a SQL server that has public network access disabled. The
 * endpoint creates a pending private endpoint connection on the target
 * server that must be approved.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/elastic-jobs-overview#elastic-job-private-endpoints
 *
 * ### Reaching Private Servers
 * **Example:** Private endpoint to a target server
 * ```typescript
 * yield* Azure.Sql.JobPrivateEndpoint("to-orders", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   jobAgent: agent.jobAgentName,
 *   targetServerId: ordersServer.serverId,
 * });
 * ```
 *
 * @resource
 */
export const JobPrivateEndpoint = Resource<JobPrivateEndpoint>(
  "Azure.Sql.JobPrivateEndpoint",
);

type Observed = sql.GetJobPrivateEndpointResponse;

const getChild = (subscriptionId: string, scope: JobAgentScope, name: string) =>
  orUndefinedIfNotFound(
    sql.GetJobPrivateEndpoint({
      ...jobAgentPath(subscriptionId, scope),
      privateEndpointName: name,
    }),
  );

const toAttrs = (
  scope: JobAgentScope,
  name: string,
  observed: Observed,
): JobPrivateEndpoint["Attributes"] => ({
  privateEndpointName: name,
  jobPrivateEndpointId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  jobAgentName: scope.jobAgentName,
  targetServerId: observed.properties?.targetServerAzureResourceId ?? "",
  privateEndpointId: observed.properties?.privateEndpointId,
});

export const JobPrivateEndpointProvider = () =>
  Provider.succeed(JobPrivateEndpoint, {
    stables: [
      "privateEndpointName",
      "jobPrivateEndpointId",
      "resourceGroup",
      "serverName",
      "jobAgentName",
    ],

    // Children of a job agent are removed with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName) ||
        lower(news.jobAgent) !== lower(output.jobAgentName) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.privateEndpointName)) ||
        lower(news.targetServerId) !== lower(output.targetServerId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.serverName ?? olds?.server;
      const jobAgentName = output?.jobAgentName ?? olds?.jobAgent;
      if (
        resourceGroup === undefined ||
        serverName === undefined ||
        jobAgentName === undefined
      ) {
        return undefined;
      }
      const scope = { resourceGroup, serverName, jobAgentName };
      const generated = yield* createChildName(id, 128);
      const name = output?.privateEndpointName ?? olds?.name ?? generated;
      const observed = yield* getChild(subscriptionId, scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, observed);
      return output !== undefined ||
        name === generated ||
        (yield* isServerOwnedByStack(subscriptionId, resourceGroup, serverName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: JobAgentScope = {
        resourceGroup: news.resourceGroup,
        serverName: news.server,
        jobAgentName: news.jobAgent,
      };
      const name =
        news.name ??
        output?.privateEndpointName ??
        (yield* createChildName(id, 128));
      const desired = { targetServerAzureResourceId: news.targetServerId };
      const get = getChild(subscriptionId, scope, name);

      // Observe, then create or converge in one upsert PUT.
      const observed = yield* get;
      if (
        observed === undefined ||
        !(
          lower(observed.properties?.targetServerAzureResourceId) ===
          lower(desired.targetServerAzureResourceId)
        )
      ) {
        yield* retryWhileAgentBusy(
          sql.JobPrivateEndpointsCreateOrUpdate({
            ...jobAgentPath(subscriptionId, scope),
            privateEndpointName: name,
            properties: desired,
          }),
        );
      }
      const fresh = yield* waitForProvisioned(
        `sql job private endpoint ${name}`,
        get,
        (observed) =>
          lower(observed.properties?.targetServerAzureResourceId) ===
          lower(desired.targetServerAzureResourceId)
            ? "Succeeded"
            : "Updating",
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(scope, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        retryWhileAgentBusy(
          sql.DeleteJobPrivateEndpoint({
            ...jobAgentPath(subscriptionId, output),
            privateEndpointName: output.privateEndpointName,
          }),
        ),
      );
      yield* waitUntilGone(
        `sql job private endpoint ${output.privateEndpointName}`,
        getChild(subscriptionId, output, output.privateEndpointName),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
