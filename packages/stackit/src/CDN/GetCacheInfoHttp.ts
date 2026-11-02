import * as cdn from "@distilled.cloud/stackit/cdn";
import * as Layer from "effect/Layer";
import { CDN_READ_ACCESS, makeDistributionHttpBinding } from "./BindingHttp.ts";
import { GetCacheInfo } from "./GetCacheInfo.ts";

/**
 * HTTP implementation of {@link GetCacheInfo}.
 *
 * @layer
 * @provides Stackit.CDN.GetCacheInfo
 */
export const GetCacheInfoHttp = Layer.effect(
  GetCacheInfo,
  makeDistributionHttpBinding({
    tag: "Stackit.CDN.GetCacheInfo",
    access: CDN_READ_ACCESS,
    operation: cdn.getCacheInfo,
  }),
);
