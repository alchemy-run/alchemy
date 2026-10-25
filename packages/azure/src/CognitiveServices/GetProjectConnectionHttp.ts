import * as projects from "@distilled.cloud/azure/ai-projects";
import * as Layer from "effect/Layer";
import { AIRole, makeProjectHttpBinding } from "./AIBindingHttp.ts";
import { GetProjectConnection } from "./GetProjectConnection.ts";

/**
 * Implementation of {@link GetProjectConnection} over the distilled `ai-projects`
 * data plane. Assigns the custom `AzureAIProjectConnectionsReadRole` on the project.
 *
 * @layer
 * @provides Azure.CognitiveServices.GetProjectConnection
 */
export const GetProjectConnectionHttp = Layer.effect(
  GetProjectConnection,
  makeProjectHttpBinding({
    tag: "Azure.CognitiveServices.GetProjectConnection",
    operation: projects.GetConnection,
    grant: AIRole.ProjectConnectionsRead,
  }),
);
