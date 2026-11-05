import * as ram from "@distilled.cloud/aws/ram";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeRAMHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `ram:ListResources`.
 *
 * Lists the resources that you added to resource shares or that are shared with you.
 * Account-level operation — the target shares, invitations, and permissions
 * are chosen per request at runtime, so the binding takes no resource
 * argument. Provide the implementation with
 * `Effect.provide(AWS.RAM.ListResourcesHttp)`.
 * ### Discovering Shares & Shared Resources
 * **Example:** List the Resources Shared with You
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listResources = yield* AWS.RAM.ListResources();
 *
 * // runtime
 * const { resources } = yield* listResources({
 *   resourceOwner: "OTHER-ACCOUNTS",
 * });
 * ```
 *
 * @binding
 */
export interface ListResources extends Binding.Service<
  ListResources,
  "AWS.RAM.ListResources",
  () => Effect.Effect<
    (
      request: ram.ListResourcesRequest,
    ) => Effect.Effect<ram.ListResourcesResponse, ram.ListResourcesError>
  >
> {}
export const ListResources = Binding.Service<ListResources>("AWS.RAM.ListResources");

export const ListResourcesHttp = Layer.effect(
  ListResources,
  makeRAMHttpBinding({
    capability: "ListResources",
    iamActions: ["ram:ListResources"],
    operation: ram.listResources,
  }),
);
