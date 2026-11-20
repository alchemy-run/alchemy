import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeSubscriptionHttpBinding } from "./BindingHttp.ts";
import type { Subscription } from "./Subscription.ts";

export interface PullRequest extends Omit<
  pubsub.PullProjectsSubscriptionsRequest,
  "subscription"
> {}

/**
 * Runtime binding for Pub/Sub `subscriptions.pull`.
 *
 * Bind this operation to a {@link Subscription} in a Function/Action init
 * phase. Provide {@link PullHttp}.
 *
 * ### Pulling Messages
 * **Example:** Pull messages
 * ```typescript
 * const pull = yield* GCP.PubSub.Pull(subscription);
 * const { receivedMessages } = yield* pull({
 *   body: { maxMessages: 10 },
 * });
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface Pull extends Binding.Service<
  Pull,
  "GCP.PubSub.Pull",
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request: PullRequest,
    ) => Effect.Effect<pubsub.PullResponse, pubsub.PullProjectsSubscriptionsError, RuntimeContext>
  >
> {}

export const Pull = Binding.Service<Pull>("GCP.PubSub.Pull");

/**
 * HTTP implementation of {@link Pull}.
 *
 * @layer
 * @provides GCP.PubSub.Pull
 */
export const PullHttp = Layer.effect(
  Pull,
  makeSubscriptionHttpBinding({
    tag: "GCP.PubSub.Pull",
    iam: { role: "roles/pubsub.subscriber", on: "pubsub.subscription" },
    operation: pubsub.pullProjectsSubscriptions,
  }),
);
