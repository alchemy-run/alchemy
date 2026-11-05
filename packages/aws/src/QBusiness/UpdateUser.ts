import * as qbusiness from "@distilled.cloud/aws/qbusiness";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Application } from "./Application.ts";
import { makeQBusinessApplicationHttpBinding } from "./BindingHttp.ts";

/**
 * `UpdateUser` request with `applicationId` injected from the bound application.
 */
export interface UpdateUserRequest extends Omit<qbusiness.UpdateUserRequest, "applicationId"> {}

/**
 * Runtime binding for the `UpdateUser` operation (IAM action
 * `qbusiness:UpdateUser`), scoped to one {@link Application}.
 *
 * Adds and removes alias mappings for a user.
 * Provide the implementation with
 * `Effect.provide(AWS.QBusiness.UpdateUserHttp)`.
 *
 * ### User Management
 * **Example:** Update a User's Aliases
 * ```typescript
 * const updateUser = yield* AWS.QBusiness.UpdateUser(app);
 *
 * yield* updateUser({
 *   userId: "user@example.com",
 *   userAliasesToUpdate: [{ userId: "corp\\user" }],
 * });
 * ```
 *
 * @binding
 */
export interface UpdateUser extends Binding.Service<
  UpdateUser,
  "AWS.QBusiness.UpdateUser",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: UpdateUserRequest,
    ) => Effect.Effect<qbusiness.UpdateUserResponse, qbusiness.UpdateUserError>
  >
> {}
export const UpdateUser = Binding.Service<UpdateUser>("AWS.QBusiness.UpdateUser");

export const UpdateUserHttp = Layer.effect(
  UpdateUser,
  makeQBusinessApplicationHttpBinding({
    tag: "AWS.QBusiness.UpdateUser",
    operation: qbusiness.updateUser,
    actions: ["qbusiness:UpdateUser"],
  }),
);
