import type * as SVC from "@distilled.cloud/aws/finspace";
import * as finspace from "@distilled.cloud/aws/finspace";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:GetKxChangeset` — reads one changeset of a kdb database in the bound environment — status, change requests, and error details — so ingestion pipelines can poll a changeset to `COMPLETED`.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.GetKxChangesetHttp)`.
 * ### Ingesting Data
 * **Example:** Poll a Changeset
 * ```typescript
 * const getChangeset = yield* AWS.FinSpace.GetKxChangeset(kdb);
 *
 * const { status } = yield* getChangeset({
 *   databaseName: "ticks",
 *   changesetId,
 * });
 * ```
 *
 * @binding
 */
export interface GetKxChangeset extends Binding.Service<
  GetKxChangeset,
  "AWS.FinSpace.GetKxChangeset",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.GetKxChangesetRequest, "environmentId">,
    ) => Effect.Effect<SVC.GetKxChangesetResponse, SVC.GetKxChangesetError>
  >
> {}
export const GetKxChangeset = Binding.Service<GetKxChangeset>("AWS.FinSpace.GetKxChangeset");

export const GetKxChangesetHttp = Layer.effect(
  GetKxChangeset,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.GetKxChangeset",
    operation: finspace.getKxChangeset,
    actions: ["finspace:GetKxChangeset"],
  }),
);
