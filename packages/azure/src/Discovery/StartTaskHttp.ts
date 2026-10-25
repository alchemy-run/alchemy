import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { StartTask } from "./StartTask.ts";

/**
 * Implementation of {@link StartTask} over the distilled `discovery-workspace`
 * data plane. Assigns the custom `AzureDiscoveryInvestigationWriteRole` on the
 * workspace.
 *
 * @layer
 * @provides Azure.Discovery.StartTask
 */
export const StartTaskHttp = Layer.effect(
  StartTask,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.StartTask",
    operation: discovery.StartTask,
    grant: DiscoveryRole.InvestigationWrite,
  }),
);
