import * as fms from "@distilled.cloud/aws/fms";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";

/**
 * Request for {@link ListAppsLists}.
 */
export interface ListAppsListsRequest extends fms.ListAppsListsRequest {}

/**
 * Runtime binding for `fms:ListAppsLists`.
 *
 * Returns an array of `AppsListDataSummary` objects for the applications lists in the administrator's account. Provide the
 * implementation with `Effect.provide(AWS.FMS.ListAppsListsHttp)`.
 * ### Applications Lists
 * **Example:** List Applications Lists
 * ```typescript
 * // init — account-level binding takes no resource
 * const listAppsLists = yield* AWS.FMS.ListAppsLists();
 *
 * // runtime
 * const result = yield* listAppsLists({ MaxResults: 25 });
 * console.log(result.AppsLists?.length);
 * ```
 *
 * @binding
 */
export interface ListAppsLists extends Binding.Service<
  ListAppsLists,
  "AWS.FMS.ListAppsLists",
  () => Effect.Effect<
    (
      request: ListAppsListsRequest,
    ) => Effect.Effect<fms.ListAppsListsResponse, fms.ListAppsListsError>
  >
> {}

export const ListAppsLists = Binding.Service<ListAppsLists>("AWS.FMS.ListAppsLists");

export const ListAppsListsHttp = Layer.effect(
  ListAppsLists,
  makeFmsHttpBinding({
    capability: "ListAppsLists",
    iamActions: ["fms:ListAppsLists"],
    operation: fms.listAppsLists,
  }),
);
