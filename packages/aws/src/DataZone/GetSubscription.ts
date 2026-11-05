import * as datazone from "@distilled.cloud/aws/datazone";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeDataZoneDomainHttpBinding } from "./BindingHttp.ts";
import type { Domain } from "./Domain.ts";

export interface GetSubscriptionRequest extends Omit<
  datazone.GetSubscriptionInput,
  "domainIdentifier"
> {}

/**
 * Runtime binding for `datazone:GetSubscription`.
 *
 * Reads a subscription in the bound domain. The domain id is injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.GetSubscriptionHttp)`.
 * ### Subscription Workflows
 * **Example:** Read a Subscription
 * ```typescript
 * // init — bind the operation to the domain
 * const getSubscription = yield* AWS.DataZone.GetSubscription(domain);
 *
 * // runtime
 * const sub = yield* getSubscription({ identifier: subscriptionId });
 * ```
 *
 * @binding
 */
export interface GetSubscription extends Binding.Service<
  GetSubscription,
  "AWS.DataZone.GetSubscription",
  (
    domain: Domain,
  ) => Effect.Effect<
    (
      request: GetSubscriptionRequest,
    ) => Effect.Effect<datazone.GetSubscriptionOutput, datazone.GetSubscriptionError>
  >
> {}
export const GetSubscription = Binding.Service<GetSubscription>("AWS.DataZone.GetSubscription");

export const GetSubscriptionHttp = Layer.effect(
  GetSubscription,
  makeDataZoneDomainHttpBinding({
    tag: "AWS.DataZone.GetSubscription",
    operation: datazone.getSubscription,
    actions: ["datazone:GetSubscription"],
  }),
);
