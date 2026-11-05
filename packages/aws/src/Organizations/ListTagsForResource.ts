import * as organizations from "@distilled.cloud/aws/organizations";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `organizations:ListTagsForResource`.
 *
 * Lists the tags attached to the specified Organizations resource — an account, root, organizational unit, or policy.
 * Account-level operation — Organizations is a management-account-scoped
 * global service, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Organizations.ListTagsForResourceHttp)`.
 * ### Tags
 * **Example:** Read an Account's Organization Tags
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listTagsForResource = yield* AWS.Organizations.ListTagsForResource();
 *
 * // runtime
 * const { Tags } = yield* listTagsForResource({ ResourceId: accountId });
 * ```
 *
 * @binding
 */
export interface ListTagsForResource extends Binding.Service<
  ListTagsForResource,
  "AWS.Organizations.ListTagsForResource",
  () => Effect.Effect<
    (
      request: organizations.ListTagsForResourceRequest,
    ) => Effect.Effect<
      organizations.ListTagsForResourceResponse,
      organizations.ListTagsForResourceError
    >
  >
> {}
export const ListTagsForResource = Binding.Service<ListTagsForResource>(
  "AWS.Organizations.ListTagsForResource",
);

export const ListTagsForResourceHttp = Layer.effect(
  ListTagsForResource,
  makeOrganizationsHttpBinding({
    capability: "ListTagsForResource",
    iamActions: ["organizations:ListTagsForResource"],
    operation: organizations.listTagsForResource,
  }),
);
