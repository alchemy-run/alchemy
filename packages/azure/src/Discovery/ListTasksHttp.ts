import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";
import { ListTasks } from "./ListTasks.ts";

/**
 * Implementation of {@link ListTasks} over the distilled `discovery-workspace`
 * data plane. Assigns the custom `AzureDiscoveryInvestigationReadRole` on the
 * workspace.
 *
 * @layer
 * @provides Azure.Discovery.ListTasks
 */
export const ListTasksHttp = Layer.effect(
  ListTasks,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.ListTasks",
    operation: discovery.ListTasks,
    grant: DiscoveryRole.InvestigationRead,
  }),
);
