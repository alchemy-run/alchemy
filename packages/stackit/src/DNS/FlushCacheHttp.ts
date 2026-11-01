import * as dns from "@distilled.cloud/stackit/dns";
import * as Layer from "effect/Layer";
import { makeResolverHttpBinding } from "./BindingHttp.ts";
import { FlushCache } from "./FlushCache.ts";

/**
 * HTTP implementation of {@link FlushCache}.
 *
 * @layer
 * @provides Stackit.DNS.FlushCache
 */
export const FlushCacheHttp = Layer.effect(
  FlushCache,
  makeResolverHttpBinding({ tag: "Stackit.DNS.FlushCache", operation: dns.flush }),
);
