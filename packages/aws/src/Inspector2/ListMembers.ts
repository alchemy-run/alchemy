import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `inspector2:ListMembers`.
 *
 * List members associated with the Amazon Inspector delegated administrator for your
 * organization.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.ListMembersHttp)`.
 * ### Organization & Members
 * **Example:** List Member Accounts
 * ```typescript
 * // init
 * const listMembers = yield* AWS.Inspector2.ListMembers();
 *
 * // runtime
 * const { members } = yield* listMembers();
 * ```
 *
 * @binding
 */
export interface ListMembers extends Binding.Service<
  ListMembers,
  "AWS.Inspector2.ListMembers",
  () => Effect.Effect<
    (
      request?: inspector2.ListMembersRequest,
    ) => Effect.Effect<inspector2.ListMembersResponse, inspector2.ListMembersError>
  >
> {}
export const ListMembers = Binding.Service<ListMembers>("AWS.Inspector2.ListMembers");

export const ListMembersHttp = Layer.effect(
  ListMembers,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.ListMembers",
    operation: inspector2.listMembers,
    actions: ["inspector2:ListMembers"],
  }),
);
