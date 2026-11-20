import type * as SVC from "@distilled.cloud/aws/finspace";
import * as finspace from "@distilled.cloud/aws/finspace";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:ListKxDatabases` — lists the kdb databases of the bound environment.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.ListKxDatabasesHttp)`.
 * ### Reading Databases
 * **Example:** List Databases
 * ```typescript
 * const listDatabases = yield* AWS.FinSpace.ListKxDatabases(kdb);
 *
 * const { kxDatabases } = yield* listDatabases();
 * ```
 *
 * @binding
 */
export interface ListKxDatabases extends Binding.Service<
  ListKxDatabases,
  "AWS.FinSpace.ListKxDatabases",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListKxDatabasesRequest, "environmentId">,
    ) => Effect.Effect<SVC.ListKxDatabasesResponse, SVC.ListKxDatabasesError>
  >
> {}
export const ListKxDatabases = Binding.Service<ListKxDatabases>("AWS.FinSpace.ListKxDatabases");

export const ListKxDatabasesHttp = Layer.effect(
  ListKxDatabases,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.ListKxDatabases",
    operation: finspace.listKxDatabases,
    actions: ["finspace:ListKxDatabases"],
  }),
);
