import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostAccess from "../HostAccess.ts";
import { cognitoMethods } from "./BindingHttp.ts";
import type { UserPool } from "./UserPool.ts";
import {
  UserPoolAdmin,
  type ListGroupsRequest,
  type ListUsersRequest,
  type UserPoolAdminClient,
} from "./UserPoolAdmin.ts";

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
    const adminCreateUser = yield* HostAccess.withCredentials(cip.adminCreateUser);
    const adminGetUser = yield* HostAccess.withCredentials(cip.adminGetUser);
    const adminSetUserPassword = yield* HostAccess.withCredentials(cip.adminSetUserPassword);
    const adminUpdateUserAttributes = yield* HostAccess.withCredentials(
      cip.adminUpdateUserAttributes,
    );
    const adminDeleteUserAttributes = yield* HostAccess.withCredentials(
      cip.adminDeleteUserAttributes,
    );
    const adminDeleteUser = yield* HostAccess.withCredentials(cip.adminDeleteUser);
    const adminConfirmSignUp = yield* HostAccess.withCredentials(cip.adminConfirmSignUp);
    const adminDisableUser = yield* HostAccess.withCredentials(cip.adminDisableUser);
    const adminEnableUser = yield* HostAccess.withCredentials(cip.adminEnableUser);
    const adminResetUserPassword = yield* HostAccess.withCredentials(cip.adminResetUserPassword);
    const adminInitiateAuth = yield* HostAccess.withCredentials(cip.adminInitiateAuth);
    const adminRespondToAuthChallenge = yield* HostAccess.withCredentials(
      cip.adminRespondToAuthChallenge,
    );
    const adminUserGlobalSignOut = yield* HostAccess.withCredentials(cip.adminUserGlobalSignOut);
    const adminAddUserToGroup = yield* HostAccess.withCredentials(cip.adminAddUserToGroup);
    const adminRemoveUserFromGroup = yield* HostAccess.withCredentials(
      cip.adminRemoveUserFromGroup,
    );
    const adminListGroupsForUser = yield* HostAccess.withCredentials(cip.adminListGroupsForUser);
    const adminSetUserMFAPreference = yield* HostAccess.withCredentials(
      cip.adminSetUserMFAPreference,
    );
    const adminLinkProviderForUser = yield* HostAccess.withCredentials(
      cip.adminLinkProviderForUser,
    );
    const adminDisableProviderForUser = yield* HostAccess.withCredentials(
      cip.adminDisableProviderForUser,
    );
    const adminGetDevice = yield* HostAccess.withCredentials(cip.adminGetDevice);
    const adminListDevices = yield* HostAccess.withCredentials(cip.adminListDevices);
    const adminForgetDevice = yield* HostAccess.withCredentials(cip.adminForgetDevice);
    const adminUpdateDeviceStatus = yield* HostAccess.withCredentials(cip.adminUpdateDeviceStatus);
    const adminListUserAuthEvents = yield* HostAccess.withCredentials(cip.adminListUserAuthEvents);
    const adminUpdateAuthEventFeedback = yield* HostAccess.withCredentials(
      cip.adminUpdateAuthEventFeedback,
    );
    const listUsers = yield* HostAccess.withCredentials(cip.listUsers);
    const listUsersInGroup = yield* HostAccess.withCredentials(cip.listUsersInGroup);
    const listGroups = yield* HostAccess.withCredentials(cip.listGroups);

    return Effect.fn(function* <P extends UserPool>(pool: P) {
      const UserPoolId = yield* pool.userPoolId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* HostAccess.bind`AWS.Cognito.UserPoolAdmin(${pool})`({
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
