import * as dataexchange from "@distilled.cloud/aws/dataexchange";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeDataExchangeAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `dataexchange:ListDataGrants`.
 *
 * Enumerates the data grants this account has sent.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.ListDataGrantsHttp)`.
 * ### Data Grants
 * **Example:** List Sent Grants
 * ```typescript
 * const listDataGrants = yield* AWS.DataExchange.ListDataGrants();
 *
 * // runtime
 * const { DataGrantSummaries } = yield* listDataGrants();
 * ```
 *
 * @binding
 */
export interface ListDataGrants extends Binding.Service<
  ListDataGrants,
  "AWS.DataExchange.ListDataGrants",
  () => Effect.Effect<
    (
      request?: dataexchange.ListDataGrantsRequest,
    ) => Effect.Effect<dataexchange.ListDataGrantsResponse, dataexchange.ListDataGrantsError>
  >
> {}
export const ListDataGrants = Binding.Service<ListDataGrants>("AWS.DataExchange.ListDataGrants");

export const ListDataGrantsHttp = Layer.effect(
  ListDataGrants,
  makeDataExchangeAccountHttpBinding({
    tag: "AWS.DataExchange.ListDataGrants",
    operation: dataexchange.listDataGrants,
    actions: ["dataexchange:ListDataGrants"],
  }),
);
