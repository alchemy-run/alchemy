import type * as SVC from "@distilled.cloud/aws/finspace";
import * as finspace from "@distilled.cloud/aws/finspace";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeFinSpaceKxHttpBinding } from "./BindingHttp.ts";
import type { KxEnvironment } from "./KxEnvironment.ts";

/**
 * Runtime binding for `finspace:GetKxUser` — reads one kdb user of the bound environment — user ARN and mapped IAM role.
 * Provide the implementation with
 * `Effect.provide(AWS.FinSpace.GetKxUserHttp)`.
 * ### Managing kdb Users
 * **Example:** Read a User
 * ```typescript
 * const getUser = yield* AWS.FinSpace.GetKxUser(kdb);
 *
 * const { userArn, iamRole } = yield* getUser({ userName: "analyst" });
 * ```
 *
 * @binding
 */
export interface GetKxUser extends Binding.Service<
  GetKxUser,
  "AWS.FinSpace.GetKxUser",
  <K extends KxEnvironment>(
    environment: K,
  ) => Effect.Effect<
    (
      request: Omit<SVC.GetKxUserRequest, "environmentId">,
    ) => Effect.Effect<SVC.GetKxUserResponse, SVC.GetKxUserError>
  >
> {}
export const GetKxUser = Binding.Service<GetKxUser>("AWS.FinSpace.GetKxUser");

export const GetKxUserHttp = Layer.effect(
  GetKxUser,
  makeFinSpaceKxHttpBinding({
    tag: "AWS.FinSpace.GetKxUser",
    operation: finspace.getKxUser,
    actions: ["finspace:GetKxUser"],
  }),
);
