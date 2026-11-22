import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { AddTaskExecutionHistory } from "./AddTaskExecutionHistory.ts";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AddTaskExecutionHistory} over the distilled
 * `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryInvestigationWriteRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.AddTaskExecutionHistory
 */
export const AddTaskExecutionHistoryHttp = Layer.effect(
  AddTaskExecutionHistory,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.AddTaskExecutionHistory",
    operation: discovery.AddTaskExecutionHistory,
    grant: DiscoveryRole.InvestigationWrite,
  }),
);
