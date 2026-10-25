import * as discovery from "@distilled.cloud/azure/discovery-workspace";
import * as Layer from "effect/Layer";
import { AddTaskComment } from "./AddTaskComment.ts";
import { DiscoveryRole, makeWorkspaceHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AddTaskComment} over the distilled
 * `discovery-workspace` data plane. Assigns the custom
 * `AzureDiscoveryInvestigationWriteRole` on the workspace.
 *
 * @layer
 * @provides Azure.Discovery.AddTaskComment
 */
export const AddTaskCommentHttp = Layer.effect(
  AddTaskComment,
  makeWorkspaceHttpBinding({
    tag: "Azure.Discovery.AddTaskComment",
    operation: discovery.AddTaskComment,
    grant: DiscoveryRole.InvestigationWrite,
  }),
);
