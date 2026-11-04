import * as pubsublite from "@distilled.cloud/gcp/pubsublite_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AdminSubscription } from "./AdminSubscription.ts";
import { makeSubscriptionHttpBinding } from "./BindingHttp.ts";

export interface CommitCursorRequest extends Omit<
  pubsublite.CommitCursorCursorProjectsLocationsSubscriptionsRequest,
  "subscription"
> {}

/**
 * Runtime binding for Pub/Sub Lite `cursor.commitCursor`.
 *
 * Bind this operation to an {@link AdminSubscription} in a Function/Action
 * init phase. Provide {@link CommitCursorHttp}.
 *
 * Grants `roles/pubsublite.subscriber` on the project: Pub/Sub Lite has no
 * resource-level IAM.
 *
 * ### Committing a Cursor
 * **Example:** Commit partition 0 to offset 10
 * ```typescript
 * const commit = yield* GCP.PubSubLite.CommitCursor(inbox);
 * yield* commit({
 *   body: { partition: "0", cursor: { offset: "10" } },
 * });
 * ```
 *
 * @binding
 * @category PubSubLite
 */
export interface CommitCursor extends Binding.Service<
  CommitCursor,
  "GCP.PubSubLite.CommitCursor",
  (
    subscription: AdminSubscription,
  ) => Effect.Effect<
    (
      request?: CommitCursorRequest,
    ) => Effect.Effect<
      pubsublite.CommitCursorResponse,
      pubsublite.CommitCursorCursorProjectsLocationsSubscriptionsError,
      RuntimeContext
    >
  >
> {}

export const CommitCursor = Binding.Service<CommitCursor>("GCP.PubSubLite.CommitCursor");

/**
 * HTTP implementation of {@link CommitCursor}.
 *
 * @layer
 * @provides GCP.PubSubLite.CommitCursor
 */
export const CommitCursorHttp = Layer.effect(
  CommitCursor,
  makeSubscriptionHttpBinding({
    tag: "GCP.PubSubLite.CommitCursor",
    iam: { role: "roles/pubsublite.subscriber" },
    field: "subscription",
    operation: pubsublite.commitCursorCursorProjectsLocationsSubscriptions,
  }),
);
