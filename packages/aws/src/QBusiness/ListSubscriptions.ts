import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Application } from "./Application.ts";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";

/**
 * `ListSubscriptions` request with `applicationId` injected from the bound application.
 */
export interface ListSubscriptionsRequest extends Omit<
  qbusiness.ListSubscriptionsRequest,
  "applicationId"
> {}

/**
 * Runtime binding for the `ListSubscriptions` operation (IAM action
 * `qbusiness:ListSubscriptions`), scoped to one {@link Application}.
 *
 * Lists the application's user and group subscriptions.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.ListSubscriptionsHttp)`.
 *
 * ### Subscriptions
 * **Example:** List Subscriptions
 * ```typescript
 * const listSubscriptions = yield* AWS.QBusiness.ListSubscriptions(app);
 *
 * const { subscriptions } = yield* listSubscriptions();
 * ```
 *
 * @binding
 */
export interface ListSubscriptions extends Binding.Service<
  ListSubscriptions,
  "AWS.QBusiness.ListSubscriptions",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request?: ListSubscriptionsRequest,
    ) => Effect.Effect<qbusiness.ListSubscriptionsResponse, qbusiness.ListSubscriptionsError>
  >
> {}
export const ListSubscriptions = Binding.Service<ListSubscriptions>(
  "AWS.QBusiness.ListSubscriptions",
);

export const ListSubscriptionsHttp = Layer.effect(
  ListSubscriptions,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.ListSubscriptions",
    operation: qbusiness.listSubscriptions,
    actions: ["qbusiness:ListSubscriptions"],
  }),
);
