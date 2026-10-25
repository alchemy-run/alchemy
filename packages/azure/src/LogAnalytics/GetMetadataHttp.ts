import * as query from "@distilled.cloud/azure/monitor-operational-insights";
import * as Layer from "effect/Layer";
import { makeWorkspaceQueryBinding } from "./BindingHttp.ts";
import { GetMetadata } from "./GetMetadata.ts";

/**
 * Implementation of {@link GetMetadata} over the distilled
 * `monitor-operational-insights` data plane. Assigns **Log Analytics Data Reader** on the workspace.
 *
 * @layer
 * @provides Azure.LogAnalytics.GetMetadata
 */
export const GetMetadataHttp = Layer.effect(
  GetMetadata,
  makeWorkspaceQueryBinding({
    tag: "Azure.LogAnalytics.GetMetadata",
    operation: query.GetMetadata,
  }),
);
