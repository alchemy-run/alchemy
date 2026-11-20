import type * as SVC from "@distilled.cloud/aws/finspace";
import * as finspace from "@distilled.cloud/aws/finspace";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:ListKxUsers` — lists the kdb users of the bound environment.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.ListKxUsersHttp)`.
 * ### Managing kdb Users
 * **Example:** List Users
 * ```typescript
 * const listUsers = yield* AWS.FinSpace.ListKxUsers(kdb);
 *
 * const { users } = yield* listUsers();
 * ```
 *
 * @binding
 */
export interface ListKxUsers extends Binding.Service<
  ListKxUsers,
  "AWS.FinSpace.ListKxUsers",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request?: Omit<SVC.ListKxUsersRequest, "environmentId">,
    ) => Effect.Effect<SVC.ListKxUsersResponse, SVC.ListKxUsersError>
  >
> {}
export const ListKxUsers = Binding.Service<ListKxUsers>("AWS.FinSpace.ListKxUsers");

export const ListKxUsersHttp = Layer.effect(
  ListKxUsers,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.ListKxUsers",
    operation: finspace.listKxUsers,
    actions: ["finspace:ListKxUsers"],
  }),
);
