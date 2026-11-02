import * as cdn from "@distilled.cloud/stackit/cdn";
import * as Layer from "effect/Layer";
import { CDN_UPDATE_ACCESS, makeDistributionHttpBinding } from "./BindingHttp.ts";
import { PurgeCache } from "./PurgeCache.ts";

/**
 * HTTP implementation of {@link PurgeCache}.
 *
 * @layer
 * @provides Stackit.CDN.PurgeCache
 */
export const PurgeCacheHttp = Layer.effect(
  PurgeCache,
  makeDistributionHttpBinding({
    tag: "Stackit.CDN.PurgeCache",
    access: CDN_UPDATE_ACCESS,
    operation: cdn.purgeCache,
  }),
);
