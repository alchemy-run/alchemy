import * as kendra from "@distilled.cloud/aws/kendra";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeKendraIndexHttpBinding } from "./BindingHttp.ts";
import type { Index } from "./SearchIndex.ts";

/**
 * `ListGroupsOlderThanOrderingId` request with `IndexId` injected from the bound index.
 */
export interface ListGroupsOlderThanOrderingIdRequest extends Omit<
  kendra.ListGroupsOlderThanOrderingIdRequest,
  "IndexId"
> {}

/**
 * Runtime binding for the `ListGroupsOlderThanOrderingId` operation (IAM action
 * `kendra:ListGroupsOlderThanOrderingId`), scoped to one {@link Index}.
 *
 * Lists groups whose principal mapping is older than the given ordering
 * id — used to find stale group mappings to refresh or delete.
 * Provide the implementation with
 * `Effect.provide(AWS.Kendra.ListGroupsOlderThanOrderingIdHttp)`.
 *
 * ### Principal Mapping
 * **Example:** List Stale Groups
 * ```typescript
 * const listGroups = yield* AWS.Kendra.ListGroupsOlderThanOrderingId(index);
 *
 * const stale = yield* listGroups({ OrderingId: orderingId });
 * console.log(stale.GroupsSummaries);
 * ```
 *
 * @binding
 */
export interface ListGroupsOlderThanOrderingId extends Binding.Service<
  ListGroupsOlderThanOrderingId,
  "AWS.Kendra.ListGroupsOlderThanOrderingId",
  (
    index: Index,
  ) => Effect.Effect<
    (
      request: ListGroupsOlderThanOrderingIdRequest,
    ) => Effect.Effect<
      kendra.ListGroupsOlderThanOrderingIdResponse,
      kendra.ListGroupsOlderThanOrderingIdError
    >
  >
> {}
export const ListGroupsOlderThanOrderingId = Binding.Service<ListGroupsOlderThanOrderingId>(
  "AWS.Kendra.ListGroupsOlderThanOrderingId",
);

export const ListGroupsOlderThanOrderingIdHttp = Layer.effect(
  ListGroupsOlderThanOrderingId,
  makeKendraIndexHttpBinding({
    tag: "AWS.Kendra.ListGroupsOlderThanOrderingId",
    operation: kendra.listGroupsOlderThanOrderingId,
    actions: ["kendra:ListGroupsOlderThanOrderingId"],
    subResources: ["data-source/*"],
  }),
);
