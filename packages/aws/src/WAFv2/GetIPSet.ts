import type * as WAFV2 from "@distilled.cloud/aws/wafv2";
import * as wafv2 from "@distilled.cloud/aws/wafv2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeWafv2IPSetHttpBinding } from "./BindingHttp.ts";
import type { IPSet } from "./IPSet.ts";

/**
 * Runtime binding for `wafv2:GetIPSet` — read the bound {@link IPSet}'s
 * current addresses; the name, scope, and id are injected automatically.
 *
 * Provide `WAFv2.GetIPSetHttp` on the hosting Lambda Function to satisfy
 * the requirement.
 * ### Managing IP Sets at Runtime
 * **Example:** Read the Current Block List
 * ```typescript
 * // init — grants wafv2:GetIPSet on the IP set
 * const getIPSet = yield* AWS.WAFv2.GetIPSet(blockList);
 *
 * // runtime
 * const { IPSet } = yield* getIPSet();
 * const addresses = IPSet?.Addresses ?? [];
 * ```
 *
 * @binding
 */
export interface GetIPSet extends Binding.Service<
  GetIPSet,
  "AWS.WAFv2.GetIPSet",
  (ipSet: IPSet) => Effect.Effect<() => Effect.Effect<WAFV2.GetIPSetResponse, WAFV2.GetIPSetError>>
> {}

export const GetIPSet = Binding.Service<GetIPSet>("AWS.WAFv2.GetIPSet");

export const GetIPSetHttp = Layer.effect(
  GetIPSet,
  makeWafv2IPSetHttpBinding({
    tag: "AWS.WAFv2.GetIPSet",
    operation: wafv2.getIPSet,
    actions: ["wafv2:GetIPSet"],
  }),
);
