import * as query from "@distilled.cloud/azure/monitor-operational-insights";
import * as Effect from "effect/Effect";
import * as AzureBindings from "../AzureBindings.ts";
import {
  GrantMonitorRoles,
  LOG_ANALYTICS_DATA_READER,
  MonitorRole,
  outputOf,
} from "../Monitor/BindingHttp.ts";
import type { MonitoredResource } from "../Monitor/MonitoredResource.ts";
import type { QueryBatchRequest } from "./QueryBatch.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Shared scaffolding for the Log Analytics query bindings (the
 * `monitor-operational-insights` data plane): resolves the distilled
 * operation once when the layer is built, injects the bound workspace's ID
 * (or the bound resource's ARM ID) per call, and assigns the binding's role
 * at deploy time.
 *
 * NOT exported from `index.ts`.
 */

/**
 * Impl Effect for a workspace-scoped query operation whose request carries
 * `workspaceId` (`ExecuteQuery`, `GetQuery`, `GetMetadata`,
 * `PostMetadata`): the runtime callable injects the bound workspace's
 * customer ID, and the deploy-time half assigns **Log Analytics Data
 * Reader** on the workspace.
 */
export const makeWorkspaceQueryBinding = <I extends { workspaceId: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.LogAnalytics.ExecuteQuery`. */
  tag: string;
  /** The distilled operation; the workspace ID is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantMonitorRoles;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (workspace: Workspace) {
      yield* grant(
        options.tag,
        [workspace],
        [workspace.workspaceId],
        [{ builtIn: LOG_ANALYTICS_DATA_READER }],
      );
      const customerId = yield* workspace.customerId;
      return Effect.fn(`${options.tag}(${workspace.LogicalId})`)(function* (
        request?: Omit<I, "workspaceId">,
      ) {
        const workspaceId = yield* customerId;
        return yield* op({ ...request, workspaceId } as I);
      });
    });
  });

/**
 * Impl Effect for `QueryBatch`: each request of the batch is a POST of
 * `/query` against the bound workspace. Assigns **Log Analytics Data
 * Reader** on the workspace.
 */
export const makeQueryBatchBinding = (tag: string) =>
  Effect.gen(function* () {
    const grant = yield* GrantMonitorRoles;
    const batch = yield* AzureBindings.withCredentials(query.QueryBatch);
    return Effect.fn(function* (workspace: Workspace) {
      yield* grant(
        tag,
        [workspace],
        [workspace.workspaceId],
        [{ builtIn: LOG_ANALYTICS_DATA_READER }],
      );
      const customerId = yield* workspace.customerId;
      return Effect.fn(`${tag}(${workspace.LogicalId})`)(function* (request: QueryBatchRequest) {
        const workspaceId = yield* customerId;
        return yield* batch({
          ...request,
          requests: request.requests.map((item) => ({
            ...item,
            path: "/query",
            method: "POST",
            workspace: workspaceId,
          })),
        });
      });
    });
  });

/**
 * Impl Effect for a resource-context query operation whose request carries
 * `resourceId` (`ExecuteQueryWithResourceId`, `GetQueryWithResourceId`):
 * the runtime callable injects the bound resource's ARM ID, and the
 * deploy-time half assigns the custom `AzureMonitorQueryResourceLogsRole`
 * (read every `Microsoft.Insights/logs` table) on that resource.
 */
export const makeResourceQueryBinding = <I extends { resourceId: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.LogAnalytics.ExecuteQueryWithResourceId`. */
  tag: string;
  /** The distilled operation; the resource ID is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantMonitorRoles;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (target: MonitoredResource) {
      const resourceId = outputOf(target.resourceId);
      yield* grant(options.tag, [target.resource], [resourceId], [MonitorRole.QueryResourceLogs]);
      const id = yield* resourceId;
      return Effect.fn(`${options.tag}(${target.resource.LogicalId})`)(function* (
        request: Omit<I, "resourceId">,
      ) {
        const value = yield* id;
        // `{resourceId+}` follows the API's leading `/`.
        return yield* op({ ...request, resourceId: value.replace(/^\/+/, "") } as I);
      });
    });
  });
