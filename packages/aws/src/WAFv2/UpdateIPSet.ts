import type * as WAFV2 from "@distilled.cloud/aws/wafv2";
import * as wafv2 from "@distilled.cloud/aws/wafv2";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { retryOptimisticLock, withWafScope } from "./internal.ts";
import type { IPSet } from "./IPSet.ts";

export interface UpdateIPSetRequest {
  /**
   * The complete new set of IP addresses and CIDR ranges — WAF replaces
   * the entire list.
   */
  addresses: string[];
  /**
   * New description of the IP set. Omitted — the existing description is
   * kept.
   */
  description?: string;
}

/**
 * Runtime binding for `wafv2:UpdateIPSet` — replace the bound
 * {@link IPSet}'s address list at runtime (the classic dynamic block list:
 * a Lambda appends offending IPs as it detects them). The binding reads the
 * IP set for a fresh `LockToken`, applies the update, and retries
 * optimistic-lock conflicts automatically.
 *
 * Provide `WAFv2.UpdateIPSetHttp` on the hosting Lambda Function to satisfy
 * the requirement.
 * ### Managing IP Sets at Runtime
 * **Example:** Add an Offending IP to the Block List
 * ```typescript
 * // init — grants wafv2:GetIPSet + wafv2:UpdateIPSet on the IP set
 * const getIPSet = yield* AWS.WAFv2.GetIPSet(blockList);
 * const updateIPSet = yield* AWS.WAFv2.UpdateIPSet(blockList);
 *
 * // runtime
 * const current = (yield* getIPSet()).IPSet?.Addresses ?? [];
 * yield* updateIPSet({ addresses: [...current, "192.0.2.7/32"] });
 * ```
 *
 * @binding
 */
export interface UpdateIPSet extends Binding.Service<
  UpdateIPSet,
  "AWS.WAFv2.UpdateIPSet",
  (
    ipSet: IPSet,
  ) => Effect.Effect<
    (
      request: UpdateIPSetRequest,
    ) => Effect.Effect<WAFV2.UpdateIPSetResponse, WAFV2.GetIPSetError | WAFV2.UpdateIPSetError>
  >
> {}

export const UpdateIPSet = Binding.Service<UpdateIPSet>("AWS.WAFv2.UpdateIPSet");

/**
 * Bespoke (multi-op) binding: reads the IP set for a fresh `LockToken`,
 * applies the full-replacement update, and retries optimistic-lock
 * conflicts by re-reading.
 */
export const UpdateIPSetHttp = Layer.effect(
  UpdateIPSet,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const get = yield* AWSBindings.withCredentials(wafv2.getIPSet);
    const update = yield* AWSBindings.withCredentials(wafv2.updateIPSet);

    return Effect.fn(function* (ipSet: IPSet) {
      const Name = yield* ipSet.ipSetName;
      const Id = yield* ipSet.ipSetId;
      const Scope = yield* ipSet.scope;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.WAFv2.UpdateIPSet(${ipSet})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["wafv2:GetIPSet", "wafv2:UpdateIPSet"],
              Resource: [ipSet.ipSetArn],
            },
          ],
        });
      }
      return Effect.fn(`AWS.WAFv2.UpdateIPSet(${ipSet.LogicalId})`)(function* (
        request: UpdateIPSetRequest,
      ) {
        const scope = yield* Scope;
        const key = { Name: yield* Name, Scope: scope, Id: yield* Id };
        return yield* retryOptimisticLock(
          withWafScope(
            scope,
            Effect.gen(function* () {
              const fresh = yield* get(key);
              return yield* update({
                ...key,
                Addresses: request.addresses,
                Description: request.description ?? fresh.IPSet?.Description,
                LockToken: fresh.LockToken ?? "",
              });
            }),
          ),
        );
      });
    });
  }),
);
