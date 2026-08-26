import type * as sqladmin from "@distilled.cloud/gcp/sqladmin_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { User } from "./User.ts";

export interface GetUserRequest extends Omit<
  sqladmin.GetUsersRequest,
  "instance" | "project" | "name"
> {}

/**
 * Runtime binding for Cloud SQL `users.get`.
 *
 * Bind this operation to a {@link User} in a Function/Action init phase.
 * Provide {@link GetUserHttp}.
 *
 * ### Observing Users
 * **Example:** Read the bound user
 * ```typescript
 * const getUser = yield* GCP.SQL.GetUser(appUser);
 * const live = yield* getUser();
 * ```
 *
 * @binding
 * @product GCP
 * @category SQL
 */
export interface GetUser extends Binding.Service<
  GetUser,
  "GCP.SQL.GetUser",
  (
    user: User,
  ) => Effect.Effect<
    (
      request?: GetUserRequest,
    ) => Effect.Effect<sqladmin.User, sqladmin.GetUsersError, RuntimeContext>
  >
> {}

export const GetUser = Binding.Service<GetUser>("GCP.SQL.GetUser");
