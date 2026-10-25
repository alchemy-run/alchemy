import * as projects from "@distilled.cloud/azure/ai-projects";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { ListProjectConnections } from "./ListProjectConnections.ts";

/**
 * Implementation of {@link ListProjectConnections} over the distilled `ai-projects`
 * data plane. Assigns the custom `AzureAIProjectConnectionsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.ListProjectConnections
 */
export const ListProjectConnectionsHttp = Layer.effect(
  ListProjectConnections,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.ListProjectConnections",
    operation: projects.ListConnections,
    grant: AIRole.ProjectConnectionsRead,
  }),
);
