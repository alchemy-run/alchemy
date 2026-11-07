import type * as SVC from "@distilled.cloud/aws/finspace";
import * as finspace from "@distilled.cloud/aws/finspace";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:ListKxDataviews` — lists the dataviews of a kdb database in the bound environment.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.ListKxDataviewsHttp)`.
 * ### Managing Dataviews
 * **Example:** List a Database's Dataviews
 * ```typescript
 * const listDataviews = yield* AWS.FinSpace.ListKxDataviews(kdb);
 *
 * const { kxDataviews } = yield* listDataviews({ databaseName: "ticks" });
 * ```
 *
 * @binding
 */
export interface ListKxDataviews extends Binding.Service<
  ListKxDataviews,
  "AWS.FinSpace.ListKxDataviews",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.ListKxDataviewsRequest, "environmentId">,
    ) => Effect.Effect<SVC.ListKxDataviewsResponse, SVC.ListKxDataviewsError>
  >
> {}
export const ListKxDataviews = Binding.Service<ListKxDataviews>("AWS.FinSpace.ListKxDataviews");

export const ListKxDataviewsHttp = Layer.effect(
  ListKxDataviews,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.ListKxDataviews",
    operation: finspace.listKxDataviews,
    actions: ["finspace:ListKxDataviews"],
  }),
);
