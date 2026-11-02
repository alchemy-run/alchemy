import * as cdn from "@distilled.cloud/stackit/cdn";
import * as Layer from "effect/Layer";
import { CDN_READ_ACCESS, makeDistributionHttpBinding } from "./BindingHttp.ts";
import { FindCachePaths } from "./FindCachePaths.ts";

/**
 * HTTP implementation of {@link FindCachePaths}.
 *
 * @layer
 * @provides Stackit.CDN.FindCachePaths
 */
export const FindCachePathsHttp = Layer.effect(
  FindCachePaths,
  makeDistributionHttpBinding({
    tag: "Stackit.CDN.FindCachePaths",
    access: CDN_READ_ACCESS,
    operation: cdn.findCachePaths,
  }),
);
