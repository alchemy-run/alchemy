import * as shield from "@distilled.cloud/aws/shield";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeShieldHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `shield:ListAttacks`.
 *
 * Lists all ongoing DDoS attacks, or all attacks in a given time window,
 * optionally filtered to specific protected-resource ARNs — the entry point
 * for a security dashboard or attack-alerting handler. Requires an active
 * Shield Advanced subscription.
 * Provide the implementation with `Effect.provide(AWS.Shield.ListAttacksHttp)`.
 * ### Attack Visibility
 * **Example:** List Ongoing Attacks
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listAttacks = yield* AWS.Shield.ListAttacks();
 *
 * // runtime — omitting the time range returns ongoing attacks
 * const { AttackSummaries } = yield* listAttacks();
 * ```
 *
 * @binding
 */
export interface ListAttacks extends Binding.Service<
  ListAttacks,
  "AWS.Shield.ListAttacks",
  () => Effect.Effect<
    (
      request?: shield.ListAttacksRequest,
    ) => Effect.Effect<shield.ListAttacksResponse, shield.ListAttacksError>
  >
> {}
export const ListAttacks = Binding.Service<ListAttacks>("AWS.Shield.ListAttacks");

export const ListAttacksHttp = Layer.effect(
  ListAttacks,
  makeShieldHttpBinding({
    tag: "AWS.Shield.ListAttacks",
    operation: shield.listAttacks,
    actions: ["shield:ListAttacks"],
  }),
);
