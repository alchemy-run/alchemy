import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { CreateTask } from "./CreateTask.ts";

/**
 * Implementation of {@link CreateTask} over the distilled `discovery-workspace`
 * data plane. Assigns the custom `AzureDiscoveryInvestigationWriteRole` on the
 * workspace.
 *
 * @layer
 * @provides Azure.Discovery.CreateTask
 */
export const CreateTaskHttp = Layer.effect(
  CreateTask,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.CreateTask",
    operation: discovery.CreateTask,
    grant: DiscoveryRole.InvestigationWrite,
  }),
);
