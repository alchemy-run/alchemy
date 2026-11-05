import * as mediaconnect from "@distilled.cloud/aws/mediaconnect";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeMediaConnectFlowHttpBinding } from "./BindingHttp.ts";
import type { Flow } from "./Flow.ts";

/**
 * Runtime binding for `mediaconnect:GrantFlowEntitlements`.
 *
 * Grants entitlements on the bound {@link Flow} so other AWS accounts can
 * subscribe to its content — e.g. a self-service affiliate portal that
 * provisions access for a new subscriber account on demand. Granting more
 * entitlements than the flow allows fails with the typed
 * `GrantFlowEntitlements420Exception` tag. The flow ARN is injected from
 * the binding. Provide the implementation with
 * `Effect.provide(AWS.MediaConnect.GrantFlowEntitlementsHttp)`.
 * ### Managing Entitlements
 * **Example:** Grant a Subscriber Access to the Flow
 * ```typescript
 * // init — bind the operation to the flow
 * const grantEntitlements = yield* AWS.MediaConnect.GrantFlowEntitlements(flow);
 *
 * // runtime
 * const { Entitlements } = yield* grantEntitlements({
 *   Entitlements: [
 *     { Name: "affiliate-west", Subscribers: ["111122223333"] },
 *   ],
 * });
 * ```
 *
 * @binding
 */
export interface GrantFlowEntitlements extends Binding.Service<
  GrantFlowEntitlements,
  "AWS.MediaConnect.GrantFlowEntitlements",
  (
    flow: Flow,
  ) => Effect.Effect<
    (
      request: Omit<mediaconnect.GrantFlowEntitlementsRequest, "FlowArn">,
    ) => Effect.Effect<
      mediaconnect.GrantFlowEntitlementsResponse,
      mediaconnect.GrantFlowEntitlementsError
    >
  >
> {}
export const GrantFlowEntitlements = Binding.Service<GrantFlowEntitlements>(
  "AWS.MediaConnect.GrantFlowEntitlements",
);

export const GrantFlowEntitlementsHttp = Layer.effect(
  GrantFlowEntitlements,
  makeMediaConnectFlowHttpBinding({
    tag: "AWS.MediaConnect.GrantFlowEntitlements",
    operation: mediaconnect.grantFlowEntitlements,
    actions: ["mediaconnect:GrantFlowEntitlements"],
    // The IAM resource types for GrantFlowEntitlements are the flow AND
    // the entitlement; entitlement ARNs are siblings of (not derived
    // from) the flow ARN, so they are granted by wildcard.
    extraResources: ["arn:aws:mediaconnect:*:*:entitlement:*"],
  }),
);
