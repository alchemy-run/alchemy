import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { GetTask } from "./GetTask.ts";

/**
 * Implementation of {@link GetTask} over the distilled `discovery-workspace`
 * data plane. Assigns the custom `AzureDiscoveryInvestigationReadRole` on the
 * workspace.
 *
 * @layer
 * @provides Azure.Discovery.GetTask
 */
export const GetTaskHttp = Layer.effect(
  GetTask,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.GetTask",
    operation: discovery.GetTask,
    grant: DiscoveryRole.InvestigationRead,
  }),
);
