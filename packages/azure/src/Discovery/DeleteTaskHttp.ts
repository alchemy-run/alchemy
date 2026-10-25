import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { DeleteTask } from "./DeleteTask.ts";

/**
 * Implementation of {@link DeleteTask} over the distilled `discovery-workspace`
 * data plane. Assigns the custom `AzureDiscoveryInvestigationWriteRole` on the
 * workspace.
 *
 * @layer
 * @provides Azure.Discovery.DeleteTask
 */
export const DeleteTaskHttp = Layer.effect(
  DeleteTask,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.DeleteTask",
    operation: discovery.DeleteTask,
    grant: DiscoveryRole.InvestigationWrite,
  }),
);
