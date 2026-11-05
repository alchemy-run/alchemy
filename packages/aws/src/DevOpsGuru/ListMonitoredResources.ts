import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `devops-guru:ListMonitoredResources`.
 *
 * Lists the resources DevOps Guru is analyzing (or supports analyzing) — an audit of what the resource collection actually covers.
 * Provide the implementation with
 * `Effect.provide(AWS.DevOpsGuru.ListMonitoredResourcesHttp)`.
 * ### Coverage Health
 * **Example:** List Analyzed Resources
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listMonitoredResources = yield* AWS.DevOpsGuru.ListMonitoredResources();
 *
 * // runtime
 * const { MonitoredResourceIdentifiers } = yield* listMonitoredResources();
 * yield* Effect.log(`monitored: ${MonitoredResourceIdentifiers?.length}`);
 * ```
 *
 * @binding
 */
export interface ListMonitoredResources extends Binding.Service<
  ListMonitoredResources,
  "AWS.DevOpsGuru.ListMonitoredResources",
  () => Effect.Effect<
    (
      request?: devopsguru.ListMonitoredResourcesRequest,
    ) => Effect.Effect<
      devopsguru.ListMonitoredResourcesResponse,
      devopsguru.ListMonitoredResourcesError
    >
  >
> {}
export const ListMonitoredResources = Binding.Service<ListMonitoredResources>(
  "AWS.DevOpsGuru.ListMonitoredResources",
);

export const ListMonitoredResourcesHttp = Layer.effect(
  ListMonitoredResources,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.ListMonitoredResources",
    operation: devopsguru.listMonitoredResources,
    actions: ["devops-guru:ListMonitoredResources"],
  }),
);
