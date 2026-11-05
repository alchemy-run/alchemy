import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { cognitoMethods } from "./BindingHttp.ts";
import type { UserPool } from "./UserPool.ts";

export interface AdminCreateUserRequest extends Omit<cip.AdminCreateUserRequest, "UserPoolId"> {}
export interface AdminGetUserRequest extends Omit<cip.AdminGetUserRequest, "UserPoolId"> {}
export interface AdminSetUserPasswordRequest extends Omit<
  cip.AdminSetUserPasswordRequest,
  "UserPoolId"
> {}
export interface AdminUpdateUserAttributesRequest extends Omit<
  cip.AdminUpdateUserAttributesRequest,
  "UserPoolId"
> {}
export interface AdminDeleteUserRequest extends Omit<cip.AdminDeleteUserRequest, "UserPoolId"> {}
export interface AdminConfirmSignUpRequest extends Omit<
  cip.AdminConfirmSignUpRequest,
  "UserPoolId"
> {}
export interface AdminDisableUserRequest extends Omit<cip.AdminDisableUserRequest, "UserPoolId"> {}
export interface AdminEnableUserRequest extends Omit<cip.AdminEnableUserRequest, "UserPoolId"> {}
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
export interface ListUsersRequest extends Omit<cip.ListUsersRequest, "UserPoolId"> {}
export interface ListUsersInGroupRequest extends Omit<cip.ListUsersInGroupRequest, "UserPoolId"> {}
export interface AdminDeleteUserAttributesRequest extends Omit<
  cip.AdminDeleteUserAttributesRequest,
  "UserPoolId"
> {}
export interface AdminListGroupsForUserRequest extends Omit<
  cip.AdminListGroupsForUserRequest,
  "UserPoolId"
> {}
export interface AdminSetUserMFAPreferenceRequest extends Omit<
  cip.AdminSetUserMFAPreferenceRequest,
  "UserPoolId"
> {}
export interface AdminLinkProviderForUserRequest extends Omit<
  cip.AdminLinkProviderForUserRequest,
  "UserPoolId"
> {}
export interface AdminDisableProviderForUserRequest extends Omit<
  cip.AdminDisableProviderForUserRequest,
  "UserPoolId"
> {}
export interface AdminGetDeviceRequest extends Omit<cip.AdminGetDeviceRequest, "UserPoolId"> {}
export interface AdminListDevicesRequest extends Omit<cip.AdminListDevicesRequest, "UserPoolId"> {}
export interface AdminForgetDeviceRequest extends Omit<
  cip.AdminForgetDeviceRequest,
  "UserPoolId"
> {}
export interface AdminUpdateDeviceStatusRequest extends Omit<
  cip.AdminUpdateDeviceStatusRequest,
  "UserPoolId"
> {}
export interface AdminListUserAuthEventsRequest extends Omit<
  cip.AdminListUserAuthEventsRequest,
  "UserPoolId"
> {}
export interface AdminUpdateAuthEventFeedbackRequest extends Omit<
  cip.AdminUpdateAuthEventFeedbackRequest,
  "UserPoolId"
> {}
export interface ListGroupsRequest extends Omit<cip.ListGroupsRequest, "UserPoolId"> {}

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
  ) => Effect.Effect<cip.AdminSetUserPasswordResponse, cip.AdminSetUserPasswordError>;
  /** Update (or add) user attributes as an administrator. */
  adminUpdateUserAttributes: (
    request: AdminUpdateUserAttributesRequest,
  ) => Effect.Effect<cip.AdminUpdateUserAttributesResponse, cip.AdminUpdateUserAttributesError>;
  /** Delete a user as an administrator. */
  adminDeleteUser: (
    request: AdminDeleteUserRequest,
  ) => Effect.Effect<cip.AdminDeleteUserResponse, cip.AdminDeleteUserError>;
  /** Confirm a user's sign-up without a confirmation code. */
  adminConfirmSignUp: (
    request: AdminConfirmSignUpRequest,
  ) => Effect.Effect<cip.AdminConfirmSignUpResponse, cip.AdminConfirmSignUpError>;
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
  ) => Effect.Effect<cip.AdminResetUserPasswordResponse, cip.AdminResetUserPasswordError>;
  /** Start an auth flow with admin credentials (e.g. `ADMIN_USER_PASSWORD_AUTH`). */
  adminInitiateAuth: (
    request: AdminInitiateAuthRequest,
  ) => Effect.Effect<cip.AdminInitiateAuthResponse, cip.AdminInitiateAuthError>;
  /** Answer an auth challenge from `adminInitiateAuth`. */
  adminRespondToAuthChallenge: (
    request: AdminRespondToAuthChallengeRequest,
  ) => Effect.Effect<cip.AdminRespondToAuthChallengeResponse, cip.AdminRespondToAuthChallengeError>;
  /** Sign a user out of all devices. */
  adminUserGlobalSignOut: (
    request: AdminUserGlobalSignOutRequest,
  ) => Effect.Effect<cip.AdminUserGlobalSignOutResponse, cip.AdminUserGlobalSignOutError>;
  /** Add a user to a group. */
  adminAddUserToGroup: (
    request: AdminAddUserToGroupRequest,
  ) => Effect.Effect<cip.AdminAddUserToGroupResponse, cip.AdminAddUserToGroupError>;
  /** Remove a user from a group. */
  adminRemoveUserFromGroup: (
    request: AdminRemoveUserFromGroupRequest,
  ) => Effect.Effect<cip.AdminRemoveUserFromGroupResponse, cip.AdminRemoveUserFromGroupError>;
  /** List users in the pool (optionally filtered). */
  listUsers: (
    request?: ListUsersRequest,
  ) => Effect.Effect<cip.ListUsersResponse, cip.ListUsersError>;
  /** List the users in a group. */
  listUsersInGroup: (
    request: ListUsersInGroupRequest,
  ) => Effect.Effect<cip.ListUsersInGroupResponse, cip.ListUsersInGroupError>;
  /** Delete attributes from a user's profile as an administrator. */
  adminDeleteUserAttributes: (
    request: AdminDeleteUserAttributesRequest,
  ) => Effect.Effect<cip.AdminDeleteUserAttributesResponse, cip.AdminDeleteUserAttributesError>;
  /** List the groups a user belongs to. */
  adminListGroupsForUser: (
    request: AdminListGroupsForUserRequest,
  ) => Effect.Effect<cip.AdminListGroupsForUserResponse, cip.AdminListGroupsForUserError>;
  /** Set a user's MFA preferences (SMS / TOTP / email) as an administrator. */
  adminSetUserMFAPreference: (
    request: AdminSetUserMFAPreferenceRequest,
  ) => Effect.Effect<cip.AdminSetUserMFAPreferenceResponse, cip.AdminSetUserMFAPreferenceError>;
  /** Link a federated identity to an existing native user. */
  adminLinkProviderForUser: (
    request: AdminLinkProviderForUserRequest,
  ) => Effect.Effect<cip.AdminLinkProviderForUserResponse, cip.AdminLinkProviderForUserError>;
  /** Unlink a federated identity from a user. */
  adminDisableProviderForUser: (
    request: AdminDisableProviderForUserRequest,
  ) => Effect.Effect<cip.AdminDisableProviderForUserResponse, cip.AdminDisableProviderForUserError>;
  /** Fetch one of a user's remembered devices. */
  adminGetDevice: (
    request: AdminGetDeviceRequest,
  ) => Effect.Effect<cip.AdminGetDeviceResponse, cip.AdminGetDeviceError>;
  /** List a user's remembered devices. */
  adminListDevices: (
    request: AdminListDevicesRequest,
  ) => Effect.Effect<cip.AdminListDevicesResponse, cip.AdminListDevicesError>;
  /** Forget (deregister) one of a user's remembered devices. */
  adminForgetDevice: (
    request: AdminForgetDeviceRequest,
  ) => Effect.Effect<cip.AdminForgetDeviceResponse, cip.AdminForgetDeviceError>;
  /** Mark a user's device as remembered or not remembered. */
  adminUpdateDeviceStatus: (
    request: AdminUpdateDeviceStatusRequest,
  ) => Effect.Effect<cip.AdminUpdateDeviceStatusResponse, cip.AdminUpdateDeviceStatusError>;
  /** List a user's sign-in auth events (threat protection history). */
  adminListUserAuthEvents: (
    request: AdminListUserAuthEventsRequest,
  ) => Effect.Effect<cip.AdminListUserAuthEventsResponse, cip.AdminListUserAuthEventsError>;
  /** Provide valid/invalid feedback on a user's auth event. */
  adminUpdateAuthEventFeedback: (
    request: AdminUpdateAuthEventFeedbackRequest,
  ) => Effect.Effect<
    cip.AdminUpdateAuthEventFeedbackResponse,
    cip.AdminUpdateAuthEventFeedbackError
  >;
  /** List the groups in the pool. */
  listGroups: (
    request?: ListGroupsRequest,
  ) => Effect.Effect<cip.ListGroupsResponse, cip.ListGroupsError>;
}

/**
 * Runtime binding for administrative Cognito user pool operations.
 *
 * Bind this to a `UserPool` inside a function runtime to get a typed client
 * for user management and admin auth flows. The binding grants the
 * corresponding `cognito-idp:*` IAM actions scoped to the pool's ARN and
 * injects the pool ID into every call.
 * ### Managing Users
 * **Example:** Create a User with a Permanent Password
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
 * **Example:** Look Up and Delete a User
 * ```typescript
 * const user = yield* admin.adminGetUser({ Username: "user@example.com" });
 * yield* admin.adminDeleteUser({ Username: "user@example.com" });
 * ```
 *
 * ### Groups
 * **Example:** Manage Group Membership
 * ```typescript
 * yield* admin.adminAddUserToGroup({
 *   Username: "user@example.com",
 *   GroupName: "Admins",
 * });
 * const admins = yield* admin.listUsersInGroup({ GroupName: "Admins" });
 * const groups = yield* admin.adminListGroupsForUser({
 *   Username: "user@example.com",
 * });
 * ```
 *
 * ### Federation and Devices
 * **Example:** Link a Federated Identity to a Native User
 * ```typescript
 * yield* admin.adminLinkProviderForUser({
 *   DestinationUser: {
 *     ProviderName: "Cognito",
 *     ProviderAttributeValue: "user@example.com",
 *   },
 *   SourceUser: {
 *     ProviderName: "Google",
 *     ProviderAttributeName: "Cognito_Subject",
 *     ProviderAttributeValue: googleSub,
 *   },
 * });
 * ```
 *
 * **Example:** List a User's Remembered Devices
 * ```typescript
 * const devices = yield* admin.adminListDevices({
 *   Username: "user@example.com",
 * });
 * ```
 *
 * @binding
 */
export interface UserPoolAdmin extends Binding.Service<
  UserPoolAdmin,
  "AWS.Cognito.UserPoolAdmin",
  <P extends UserPool>(pool: P) => Effect.Effect<UserPoolAdminClient>
> {}
export const UserPoolAdmin = Binding.Service<UserPoolAdmin>("AWS.Cognito.UserPoolAdmin");

/** The injected identifier field, in the distilled wire type. */
type UserPoolIdField = Pick<cip.AdminGetUserRequest, "UserPoolId">;

/**
 * HTTP implementation of {@link UserPoolAdmin}: grants the admin
 * `cognito-idp:*` actions on the bound pool's ARN and calls the Cognito
 * HTTP API with the function's IAM credentials.
 */
export const UserPoolAdminHttp = Layer.effect(
  UserPoolAdmin,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const adminCreateUser = yield* AWSBindings.withCredentials(cip.adminCreateUser);
    const adminGetUser = yield* AWSBindings.withCredentials(cip.adminGetUser);
    const adminSetUserPassword = yield* AWSBindings.withCredentials(cip.adminSetUserPassword);
    const adminUpdateUserAttributes = yield* AWSBindings.withCredentials(
      cip.adminUpdateUserAttributes,
    );
    const adminDeleteUserAttributes = yield* AWSBindings.withCredentials(
      cip.adminDeleteUserAttributes,
    );
    const adminDeleteUser = yield* AWSBindings.withCredentials(cip.adminDeleteUser);
    const adminConfirmSignUp = yield* AWSBindings.withCredentials(cip.adminConfirmSignUp);
    const adminDisableUser = yield* AWSBindings.withCredentials(cip.adminDisableUser);
    const adminEnableUser = yield* AWSBindings.withCredentials(cip.adminEnableUser);
    const adminResetUserPassword = yield* AWSBindings.withCredentials(cip.adminResetUserPassword);
    const adminInitiateAuth = yield* AWSBindings.withCredentials(cip.adminInitiateAuth);
    const adminRespondToAuthChallenge = yield* AWSBindings.withCredentials(
      cip.adminRespondToAuthChallenge,
    );
    const adminUserGlobalSignOut = yield* AWSBindings.withCredentials(cip.adminUserGlobalSignOut);
    const adminAddUserToGroup = yield* AWSBindings.withCredentials(cip.adminAddUserToGroup);
    const adminRemoveUserFromGroup = yield* AWSBindings.withCredentials(
      cip.adminRemoveUserFromGroup,
    );
    const adminListGroupsForUser = yield* AWSBindings.withCredentials(cip.adminListGroupsForUser);
    const adminSetUserMFAPreference = yield* AWSBindings.withCredentials(
      cip.adminSetUserMFAPreference,
    );
    const adminLinkProviderForUser = yield* AWSBindings.withCredentials(
      cip.adminLinkProviderForUser,
    );
    const adminDisableProviderForUser = yield* AWSBindings.withCredentials(
      cip.adminDisableProviderForUser,
    );
    const adminGetDevice = yield* AWSBindings.withCredentials(cip.adminGetDevice);
    const adminListDevices = yield* AWSBindings.withCredentials(cip.adminListDevices);
    const adminForgetDevice = yield* AWSBindings.withCredentials(cip.adminForgetDevice);
    const adminUpdateDeviceStatus = yield* AWSBindings.withCredentials(cip.adminUpdateDeviceStatus);
    const adminListUserAuthEvents = yield* AWSBindings.withCredentials(cip.adminListUserAuthEvents);
    const adminUpdateAuthEventFeedback = yield* AWSBindings.withCredentials(
      cip.adminUpdateAuthEventFeedback,
    );
    const listUsers = yield* AWSBindings.withCredentials(cip.listUsers);
    const listUsersInGroup = yield* AWSBindings.withCredentials(cip.listUsersInGroup);
    const listGroups = yield* AWSBindings.withCredentials(cip.listGroups);

    return Effect.fn(function* <P extends UserPool>(pool: P) {
      const UserPoolId = yield* pool.userPoolId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Cognito.UserPoolAdmin(${pool})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [
                "cognito-idp:AdminAddUserToGroup",
                "cognito-idp:AdminConfirmSignUp",
                "cognito-idp:AdminCreateUser",
                "cognito-idp:AdminDeleteUser",
                "cognito-idp:AdminDeleteUserAttributes",
                "cognito-idp:AdminDisableProviderForUser",
                "cognito-idp:AdminDisableUser",
                "cognito-idp:AdminEnableUser",
                "cognito-idp:AdminForgetDevice",
                "cognito-idp:AdminGetDevice",
                "cognito-idp:AdminGetUser",
                "cognito-idp:AdminInitiateAuth",
                "cognito-idp:AdminLinkProviderForUser",
                "cognito-idp:AdminListDevices",
                "cognito-idp:AdminListGroupsForUser",
                "cognito-idp:AdminListUserAuthEvents",
                "cognito-idp:AdminRemoveUserFromGroup",
                "cognito-idp:AdminResetUserPassword",
                "cognito-idp:AdminRespondToAuthChallenge",
                "cognito-idp:AdminSetUserMFAPreference",
                "cognito-idp:AdminSetUserPassword",
                "cognito-idp:AdminUpdateAuthEventFeedback",
                "cognito-idp:AdminUpdateDeviceStatus",
                "cognito-idp:AdminUpdateUserAttributes",
                "cognito-idp:AdminUserGlobalSignOut",
                "cognito-idp:ListGroups",
                "cognito-idp:ListUsers",
                "cognito-idp:ListUsersInGroup",
              ],
              Resource: [pool.userPoolArn],
            },
          ],
        });
      }
      const methods = cognitoMethods("AWS.Cognito.UserPoolAdmin", pool.LogicalId);
      const withPool = methods.injecting(
        Effect.map(UserPoolId, (id): UserPoolIdField => ({ UserPoolId: id })),
      );
      const adminClient: UserPoolAdminClient = {
        adminCreateUser: withPool("adminCreateUser", adminCreateUser),
        adminGetUser: withPool("adminGetUser", adminGetUser),
        adminSetUserPassword: withPool("adminSetUserPassword", adminSetUserPassword),
        adminUpdateUserAttributes: withPool("adminUpdateUserAttributes", adminUpdateUserAttributes),
        adminDeleteUserAttributes: withPool("adminDeleteUserAttributes", adminDeleteUserAttributes),
        adminDeleteUser: withPool("adminDeleteUser", adminDeleteUser),
        adminConfirmSignUp: withPool("adminConfirmSignUp", adminConfirmSignUp),
        adminDisableUser: withPool("adminDisableUser", adminDisableUser),
        adminEnableUser: withPool("adminEnableUser", adminEnableUser),
        adminResetUserPassword: withPool("adminResetUserPassword", adminResetUserPassword),
        adminInitiateAuth: withPool("adminInitiateAuth", adminInitiateAuth),
        adminRespondToAuthChallenge: withPool(
          "adminRespondToAuthChallenge",
          adminRespondToAuthChallenge,
        ),
        adminUserGlobalSignOut: withPool("adminUserGlobalSignOut", adminUserGlobalSignOut),
        adminAddUserToGroup: withPool("adminAddUserToGroup", adminAddUserToGroup),
        adminRemoveUserFromGroup: withPool("adminRemoveUserFromGroup", adminRemoveUserFromGroup),
        adminListGroupsForUser: withPool("adminListGroupsForUser", adminListGroupsForUser),
        adminSetUserMFAPreference: withPool("adminSetUserMFAPreference", adminSetUserMFAPreference),
        adminLinkProviderForUser: withPool("adminLinkProviderForUser", adminLinkProviderForUser),
        adminDisableProviderForUser: withPool(
          "adminDisableProviderForUser",
          adminDisableProviderForUser,
        ),
        adminGetDevice: withPool("adminGetDevice", adminGetDevice),
        adminListDevices: withPool("adminListDevices", adminListDevices),
        adminForgetDevice: withPool("adminForgetDevice", adminForgetDevice),
        adminUpdateDeviceStatus: withPool("adminUpdateDeviceStatus", adminUpdateDeviceStatus),
        adminListUserAuthEvents: withPool("adminListUserAuthEvents", adminListUserAuthEvents),
        adminUpdateAuthEventFeedback: withPool(
          "adminUpdateAuthEventFeedback",
          adminUpdateAuthEventFeedback,
        ),
        listUsersInGroup: withPool("listUsersInGroup", listUsersInGroup),
        // optional-request list operations stay bespoke (the helper's
        // wrapped methods take a required request object)
        listUsers: Effect.fn(`AWS.Cognito.UserPoolAdmin.listUsers(${pool.LogicalId})`)(function* (
          request: ListUsersRequest = {},
        ) {
          return yield* listUsers({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
        listGroups: Effect.fn(`AWS.Cognito.UserPoolAdmin.listGroups(${pool.LogicalId})`)(function* (
          request: ListGroupsRequest = {},
        ) {
          return yield* listGroups({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
      };
      return adminClient;
    });
  }),
);
