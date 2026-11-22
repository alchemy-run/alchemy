import * as query from "@distilled.cloud/azure/monitor-operational-insights";
import * as Layer from "effect/Layer";
import { makeWorkspaceQueryBinding } from "./BindingHttp.ts";
import { PostMetadata } from "./PostMetadata.ts";

/**
 * Implementation of {@link PostMetadata} over the distilled
 * `monitor-operational-insights` data plane. Assigns **Log Analytics Data Reader** on the workspace.
 *
 * @layer
 * @provides Azure.LogAnalytics.PostMetadata
 */
export const PostMetadataHttp = Layer.effect(
  PostMetadata,
  makeWorkspaceQueryBinding({
    tag: "Azure.LogAnalytics.PostMetadata",
    operation: query.PostMetadata,
  }),
);
