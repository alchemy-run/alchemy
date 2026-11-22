import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { UpdateTask } from "./UpdateTask.ts";

/**
 * Implementation of {@link UpdateTask} over the distilled `discovery-workspace`
 * data plane. Assigns the custom `AzureDiscoveryInvestigationWriteRole` on the
 * workspace.
 *
 * @layer
 * @provides Azure.Discovery.UpdateTask
 */
export const UpdateTaskHttp = Layer.effect(
  UpdateTask,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.UpdateTask",
    operation: discovery.UpdateTask,
    grant: DiscoveryRole.InvestigationWrite,
  }),
);
