import * as ingestion from "@distilled.cloud/azure/monitor-ingestion";
import * as insights from "@distilled.cloud/azure/monitor-insights";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import type { ResourceLike } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { GetMetricsBatchRequest } from "./GetMetricsBatch.ts";
import type { DataCollectionRuleTarget, MonitoredResource } from "./MonitoredResource.ts";
import type { UploadLogsRequest } from "./UploadLogs.ts";

/**
 * Shared scaffolding for the Azure Monitor and Log Analytics query
 * bindings: resolves the distilled operation once when the layer is built,
 * injects the bound target's identifiers per call, and assigns the
 * binding's roles at deploy time.
 *
 * NOT exported from `index.ts`.
 */

/** Azure Monitor permissions the bindings grant (Azure RBAC). */
export const MonitorPermission = {
  /** Data action the Logs Ingestion API checks on the data collection rule. */
  telemetryWrite: "Microsoft.Insights/Telemetry/Write",
  /** Read every table of a resource's logs (resource-context queries). */
  resourceLogsRead: "Microsoft.Insights/logs/*/read",
} as const;

/**
 * A role a Monitor binding assigns: a built-in role GUID, or a custom role
 * (`Azure.Authorization.RoleDefinition`, defined once per stack at the
 * subscription and assigned only on the binding's scope) with exactly
 * `actions` / `dataActions`.
 */
export type MonitorGrant =
  | { readonly builtIn: string }
  | {
      readonly role: string;
      readonly actions?: readonly string[];
      readonly dataActions?: readonly string[];
    };

/** Custom role per binding kind; the logical ID is `AzureMonitor<role>Role`. */
export const MonitorRole = {
  UploadLogs: { role: "UploadLogs", dataActions: [MonitorPermission.telemetryWrite] },
  QueryResourceLogs: { role: "QueryResourceLogs", actions: [MonitorPermission.resourceLogsRead] },
} as const satisfies Record<string, MonitorGrant>;

/**
 * Built-in **Monitoring Reader** (read on every resource,
 * `workspaces/search/action`, support tickets). The batch metrics API
 * rejects smaller grants: a custom role with `Microsoft.Insights/Metrics/Read` and
 * `Microsoft.Resources/subscriptions/resourceGroups/read` on the
 * subscription is answered `Forbidden` ("Please make sure grant 'Monitoring
 * Reader' role permission to the subscription").
 */
export const MONITORING_READER = "43d0d8ad-25c7-4714-9337-8ba259a9fe05";

/**
 * Built-in **Log Analytics Data Reader**: actions `workspaces/read` and
 * `workspaces/query/read`, data action `workspaces/tables/data/read`. The
 * smallest built-in role that runs queries.
 */
export const LOG_ANALYTICS_DATA_READER = "3b03c2da-16b3-4a49-8834-0f8130efdd3b";

/**
 * Bind arguments arrive unresolved (`Input<T>` deep-wraps the target), so a
 * field typed `string` may hold an Output or a plain string.
 */
export const outputOf = (value: string | Output.Output<string, never>): Output.Output<string, never> =>
  Output.isOutput(value) ? value : Output.literal(value);

/** Assign `grants` on each scope to the host, creating the custom roles they name. */
export const GrantMonitorRoles = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (
    tag: string,
    resources: readonly ResourceLike[],
    scopes: readonly Input<string>[],
    grants: readonly MonitorGrant[],
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [];
      for (const grant of grants) {
        let roleDefinitionId: Input<string>;
        if ("builtIn" in grant) {
          roleDefinitionId = grant.builtIn;
        } else {
          const permissions = [...(grant.actions ?? []), ...(grant.dataActions ?? [])];
          const role = yield* AzureRoleDefinition(`AzureMonitor${grant.role}Role`, {
            description: `Alchemy Azure Monitor binding: ${permissions.join(", ")}`,
            permissions: [
              {
                actions: grant.actions === undefined ? undefined : [...grant.actions],
                dataActions: grant.dataActions === undefined ? undefined : [...grant.dataActions],
              },
            ],
          });
          roleDefinitionId = role.roleDefinitionId;
        }
        for (const scope of scopes) {
          roleAssignments.push({ roleDefinitionId, scope });
        }
      }
      const names = resources.map((resource) => resource.LogicalId).join(", ");
      yield* bind`${tag}(${names})`({ roleAssignments });
    }
  });
});

/**
 * Impl Effect for {@link UploadLogs}: the runtime callable injects the
 * bound rule's ingestion endpoint and immutable ID; the deploy-time half
 * assigns the custom `AzureMonitorUploadLogsRole` on the rule.
 */
export const makeUploadLogsBinding = (tag: string) =>
  Effect.gen(function* () {
    const grant = yield* GrantMonitorRoles;
    const upload = yield* AzureBindings.withCredentials(ingestion.Upload);
    return Effect.fn(function* (rule: DataCollectionRuleTarget) {
      yield* grant(
        tag,
        [rule.resource],
        [outputOf(rule.dataCollectionRuleId)],
        [MonitorRole.UploadLogs],
      );
      const endpoint = yield* outputOf(rule.logsIngestionEndpoint);
      const ruleId = yield* outputOf(rule.immutableId);
      return Effect.fn(`${tag}(${rule.resource.LogicalId})`)(function* (
        request: UploadLogsRequest,
      ) {
        const where = yield* Effect.all({ endpoint, ruleId });
        return yield* upload({ ...request, ...where });
      });
    });
  });

/** `/subscriptions/{id}` of an ARM ID. */
const subscriptionScopeOf = (resourceId: string) =>
  `/subscriptions/${resourceId.split("/")[2] ?? ""}`;

/**
 * Impl Effect for {@link GetMetricsBatch}: the runtime callable injects the
 * subscription, the regional metrics endpoint, and the bound resources'
 * IDs; the deploy-time half assigns **Monitoring Reader** on the
 * subscription the resources are in (the batch API checks it there).
 */
export const makeMetricsBatchBinding = (tag: string) =>
  Effect.gen(function* () {
    const grant = yield* GrantMonitorRoles;
    const batch = yield* AzureBindings.withCredentials(insights.Batch);
    return Effect.fn(function* (...targets: MonitoredResource[]) {
      const first = targets[0]!;
      yield* grant(
        tag,
        targets.map((target) => target.resource),
        [Output.map(outputOf(first.resourceId), subscriptionScopeOf)],
        [{ builtIn: MONITORING_READER }],
      );
      const ids: Effect.Effect<string>[] = [];
      for (const target of targets) {
        const id = yield* outputOf(target.resourceId);
        ids.push(id);
      }
      const location = yield* outputOf(first.location);
      return Effect.fn(`${tag}(${targets.map((t) => t.resource.LogicalId).join(", ")})`)(function* (
        request: GetMetricsBatchRequest,
      ) {
        const resourceids: string[] = [];
        for (const id of ids) {
          const value = yield* id;
          resourceids.push(value);
        }
        const region = yield* location;
        const { metricnames, ...rest } = request;
        return yield* batch({
          ...rest,
          endpoint: `https://${region}.metrics.monitor.azure.com`,
          subscriptionId: resourceids[0]!.split("/")[2] ?? "",
          // The API takes one comma-separated `metricnames` value.
          metricnames: [metricnames.join(",")],
          resourceids,
        });
      });
    });
  });
