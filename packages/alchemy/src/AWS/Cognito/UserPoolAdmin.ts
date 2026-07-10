import type * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { UserPool } from "./UserPool.ts";

export interface AdminCreateUserRequest extends Omit<
  cip.AdminCreateUserRequest,
  "UserPoolId"
> {}
export interface AdminGetUserRequest extends Omit<
  cip.AdminGetUserRequest,
  "UserPoolId"
> {}
export interface AdminSetUserPasswordRequest extends Omit<
  cip.AdminSetUserPasswordRequest,
  "UserPoolId"
> {}
export interface AdminUpdateUserAttributesRequest extends Omit<
  cip.AdminUpdateUserAttributesRequest,
  "UserPoolId"
> {}
export interface AdminDeleteUserRequest extends Omit<
  cip.AdminDeleteUserRequest,
  "UserPoolId"
> {}
export interface AdminConfirmSignUpRequest extends Omit<
  cip.AdminConfirmSignUpRequest,
  "UserPoolId"
> {}
export interface AdminDisableUserRequest extends Omit<
  cip.AdminDisableUserRequest,
  "UserPoolId"
> {}
export interface AdminEnableUserRequest extends Omit<
  cip.AdminEnableUserRequest,
  "UserPoolId"
> {}
export interface AdminResetUserPasswordRequest extends Omit<
  cip.AdminResetUserPasswordRequest,
  "UserPoolId"
> {}
export interface AdminInitiateAuthRequest extends Omit<
  cip.AdminInitiateAuthRequest,
  "UserPoolId"
> {}
export interface AdminRespondToAuthChallengeRequest extends Omit<
  cip.AdminRespondToAuthChallengeRequest,
  "UserPoolId"
> {}
export interface AdminUserGlobalSignOutRequest extends Omit<
  cip.AdminUserGlobalSignOutRequest,
  "UserPoolId"
> {}
export interface AdminAddUserToGroupRequest extends Omit<
  cip.AdminAddUserToGroupRequest,
  "UserPoolId"
> {}
export interface AdminRemoveUserFromGroupRequest extends Omit<
  cip.AdminRemoveUserFromGroupRequest,
  "UserPoolId"
> {}
export interface ListUsersRequest extends Omit<
  cip.ListUsersRequest,
  "UserPoolId"
> {}
export interface ListUsersInGroupRequest extends Omit<
  cip.ListUsersInGroupRequest,
  "UserPoolId"
> {}

/**
 * The typed client returned by binding {@link UserPoolAdmin} to a
 * `UserPool`. Every method automatically injects the user pool ID and is
 * authorized by IAM (`cognito-idp:Admin*` on the pool ARN).
 */
export interface UserPoolAdminClient {
  /** Create a user as an administrator (optionally suppressing the invite). */
  adminCreateUser: (
    request: AdminCreateUserRequest,
  ) => Effect.Effect<cip.AdminCreateUserResponse, cip.AdminCreateUserError>;
  /** Fetch a user's profile and status by username. */
  adminGetUser: (
    request: AdminGetUserRequest,
  ) => Effect.Effect<cip.AdminGetUserResponse, cip.AdminGetUserError>;
  /** Set a user's password (permanent or temporary). */
  adminSetUserPassword: (
    request: AdminSetUserPasswordRequest,
  ) => Effect.Effect<
    cip.AdminSetUserPasswordResponse,
    cip.AdminSetUserPasswordError
  >;
  /** Update (or add) user attributes as an administrator. */
  adminUpdateUserAttributes: (
    request: AdminUpdateUserAttributesRequest,
  ) => Effect.Effect<
    cip.AdminUpdateUserAttributesResponse,
    cip.AdminUpdateUserAttributesError
  >;
  /** Delete a user as an administrator. */
  adminDeleteUser: (
    request: AdminDeleteUserRequest,
  ) => Effect.Effect<cip.AdminDeleteUserResponse, cip.AdminDeleteUserError>;
  /** Confirm a user's sign-up without a confirmation code. */
  adminConfirmSignUp: (
    request: AdminConfirmSignUpRequest,
  ) => Effect.Effect<
    cip.AdminConfirmSignUpResponse,
    cip.AdminConfirmSignUpError
  >;
  /** Disable a user (prevents sign-in and revokes tokens). */
  adminDisableUser: (
    request: AdminDisableUserRequest,
  ) => Effect.Effect<cip.AdminDisableUserResponse, cip.AdminDisableUserError>;
  /** Re-enable a disabled user. */
  adminEnableUser: (
    request: AdminEnableUserRequest,
  ) => Effect.Effect<cip.AdminEnableUserResponse, cip.AdminEnableUserError>;
  /** Force a password reset on next sign-in. */
  adminResetUserPassword: (
    request: AdminResetUserPasswordRequest,
  ) => Effect.Effect<
    cip.AdminResetUserPasswordResponse,
    cip.AdminResetUserPasswordError
  >;
  /** Start an auth flow with admin credentials (e.g. `ADMIN_USER_PASSWORD_AUTH`). */
  adminInitiateAuth: (
    request: AdminInitiateAuthRequest,
  ) => Effect.Effect<cip.AdminInitiateAuthResponse, cip.AdminInitiateAuthError>;
  /** Answer an auth challenge from `adminInitiateAuth`. */
  adminRespondToAuthChallenge: (
    request: AdminRespondToAuthChallengeRequest,
  ) => Effect.Effect<
    cip.AdminRespondToAuthChallengeResponse,
    cip.AdminRespondToAuthChallengeError
  >;
  /** Sign a user out of all devices. */
  adminUserGlobalSignOut: (
    request: AdminUserGlobalSignOutRequest,
  ) => Effect.Effect<
    cip.AdminUserGlobalSignOutResponse,
    cip.AdminUserGlobalSignOutError
  >;
  /** Add a user to a group. */
  adminAddUserToGroup: (
    request: AdminAddUserToGroupRequest,
  ) => Effect.Effect<
    cip.AdminAddUserToGroupResponse,
    cip.AdminAddUserToGroupError
  >;
  /** Remove a user from a group. */
  adminRemoveUserFromGroup: (
    request: AdminRemoveUserFromGroupRequest,
  ) => Effect.Effect<
    cip.AdminRemoveUserFromGroupResponse,
    cip.AdminRemoveUserFromGroupError
  >;
  /** List users in the pool (optionally filtered). */
  listUsers: (
    request?: ListUsersRequest,
  ) => Effect.Effect<cip.ListUsersResponse, cip.ListUsersError>;
  /** List the users in a group. */
  listUsersInGroup: (
    request: ListUsersInGroupRequest,
  ) => Effect.Effect<cip.ListUsersInGroupResponse, cip.ListUsersInGroupError>;
}

/**
 * Runtime binding for administrative Cognito user pool operations.
 *
 * Bind this to a `UserPool` inside a function runtime to get a typed client
 * for user management and admin auth flows. The binding grants the
 * corresponding `cognito-idp:*` IAM actions scoped to the pool's ARN and
 * injects the pool ID into every call.
 * @binding
 * @section Managing Users
 * @example Create a User with a Permanent Password
 * ```typescript
 * const admin = yield* Cognito.UserPoolAdmin(pool);
 *
 * yield* admin.adminCreateUser({
 *   Username: "user@example.com",
 *   MessageAction: "SUPPRESS",
 *   UserAttributes: [
 *     { Name: "email", Value: "user@example.com" },
 *     { Name: "email_verified", Value: "true" },
 *   ],
 * });
 * yield* admin.adminSetUserPassword({
 *   Username: "user@example.com",
 *   Password: "Sup3r-secret!",
 *   Permanent: true,
 * });
 * ```
 *
 * @example Look Up and Delete a User
 * ```typescript
 * const user = yield* admin.adminGetUser({ Username: "user@example.com" });
 * yield* admin.adminDeleteUser({ Username: "user@example.com" });
 * ```
 *
 * @section Groups
 * @example Manage Group Membership
 * ```typescript
 * yield* admin.adminAddUserToGroup({
 *   Username: "user@example.com",
 *   GroupName: "Admins",
 * });
 * const admins = yield* admin.listUsersInGroup({ GroupName: "Admins" });
 * ```
 */
export interface UserPoolAdmin extends Binding.Service<
  UserPoolAdmin,
  "AWS.Cognito.UserPoolAdmin",
  <P extends UserPool>(pool: P) => Effect.Effect<UserPoolAdminClient>
> {}
export const UserPoolAdmin = Binding.Service<UserPoolAdmin>(
  "AWS.Cognito.UserPoolAdmin",
);
