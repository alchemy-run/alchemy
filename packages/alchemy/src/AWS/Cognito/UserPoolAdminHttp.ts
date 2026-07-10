import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import type { UserPool } from "./UserPool.ts";
import {
  UserPoolAdmin,
  type AdminAddUserToGroupRequest,
  type AdminConfirmSignUpRequest,
  type AdminCreateUserRequest,
  type AdminDeleteUserRequest,
  type AdminDisableUserRequest,
  type AdminEnableUserRequest,
  type AdminGetUserRequest,
  type AdminInitiateAuthRequest,
  type AdminRemoveUserFromGroupRequest,
  type AdminResetUserPasswordRequest,
  type AdminRespondToAuthChallengeRequest,
  type AdminSetUserPasswordRequest,
  type AdminUpdateUserAttributesRequest,
  type AdminUserGlobalSignOutRequest,
  type ListUsersInGroupRequest,
  type ListUsersRequest,
  type UserPoolAdminClient,
} from "./UserPoolAdmin.ts";

/**
 * HTTP implementation of {@link UserPoolAdmin}: grants the admin
 * `cognito-idp:*` actions on the bound pool's ARN and calls the Cognito
 * HTTP API with the function's IAM credentials.
 */
export const UserPoolAdminHttp = Layer.effect(
  UserPoolAdmin,
  Effect.gen(function* () {
    const adminCreateUser = yield* cip.adminCreateUser;
    const adminGetUser = yield* cip.adminGetUser;
    const adminSetUserPassword = yield* cip.adminSetUserPassword;
    const adminUpdateUserAttributes = yield* cip.adminUpdateUserAttributes;
    const adminDeleteUser = yield* cip.adminDeleteUser;
    const adminConfirmSignUp = yield* cip.adminConfirmSignUp;
    const adminDisableUser = yield* cip.adminDisableUser;
    const adminEnableUser = yield* cip.adminEnableUser;
    const adminResetUserPassword = yield* cip.adminResetUserPassword;
    const adminInitiateAuth = yield* cip.adminInitiateAuth;
    const adminRespondToAuthChallenge = yield* cip.adminRespondToAuthChallenge;
    const adminUserGlobalSignOut = yield* cip.adminUserGlobalSignOut;
    const adminAddUserToGroup = yield* cip.adminAddUserToGroup;
    const adminRemoveUserFromGroup = yield* cip.adminRemoveUserFromGroup;
    const listUsers = yield* cip.listUsers;
    const listUsersInGroup = yield* cip.listUsersInGroup;

    return Effect.fn(function* <P extends UserPool>(pool: P) {
      const UserPoolId = yield* pool.userPoolId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          yield* host.bind`Allow(${host}, AWS.Cognito.UserPoolAdmin(${pool}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [
                  "cognito-idp:AdminAddUserToGroup",
                  "cognito-idp:AdminConfirmSignUp",
                  "cognito-idp:AdminCreateUser",
                  "cognito-idp:AdminDeleteUser",
                  "cognito-idp:AdminDisableUser",
                  "cognito-idp:AdminEnableUser",
                  "cognito-idp:AdminGetUser",
                  "cognito-idp:AdminInitiateAuth",
                  "cognito-idp:AdminRemoveUserFromGroup",
                  "cognito-idp:AdminResetUserPassword",
                  "cognito-idp:AdminRespondToAuthChallenge",
                  "cognito-idp:AdminSetUserPassword",
                  "cognito-idp:AdminUpdateUserAttributes",
                  "cognito-idp:AdminUserGlobalSignOut",
                  "cognito-idp:ListUsers",
                  "cognito-idp:ListUsersInGroup",
                ],
                Resource: [pool.userPoolArn],
              },
            ],
          });
        }
      }
      const logicalId = pool.LogicalId;
      const adminClient: UserPoolAdminClient = {
        adminCreateUser: Effect.fn(
          `AWS.Cognito.UserPoolAdmin.adminCreateUser(${logicalId})`,
        )(function* (request: AdminCreateUserRequest) {
          return yield* adminCreateUser({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
        adminGetUser: Effect.fn(
          `AWS.Cognito.UserPoolAdmin.adminGetUser(${logicalId})`,
        )(function* (request: AdminGetUserRequest) {
          return yield* adminGetUser({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
        adminSetUserPassword: Effect.fn(
          `AWS.Cognito.UserPoolAdmin.adminSetUserPassword(${logicalId})`,
        )(function* (request: AdminSetUserPasswordRequest) {
          return yield* adminSetUserPassword({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
        adminUpdateUserAttributes: Effect.fn(
          `AWS.Cognito.UserPoolAdmin.adminUpdateUserAttributes(${logicalId})`,
        )(function* (request: AdminUpdateUserAttributesRequest) {
          return yield* adminUpdateUserAttributes({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
        adminDeleteUser: Effect.fn(
          `AWS.Cognito.UserPoolAdmin.adminDeleteUser(${logicalId})`,
        )(function* (request: AdminDeleteUserRequest) {
          return yield* adminDeleteUser({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
        adminConfirmSignUp: Effect.fn(
          `AWS.Cognito.UserPoolAdmin.adminConfirmSignUp(${logicalId})`,
        )(function* (request: AdminConfirmSignUpRequest) {
          return yield* adminConfirmSignUp({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
        adminDisableUser: Effect.fn(
          `AWS.Cognito.UserPoolAdmin.adminDisableUser(${logicalId})`,
        )(function* (request: AdminDisableUserRequest) {
          return yield* adminDisableUser({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
        adminEnableUser: Effect.fn(
          `AWS.Cognito.UserPoolAdmin.adminEnableUser(${logicalId})`,
        )(function* (request: AdminEnableUserRequest) {
          return yield* adminEnableUser({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
        adminResetUserPassword: Effect.fn(
          `AWS.Cognito.UserPoolAdmin.adminResetUserPassword(${logicalId})`,
        )(function* (request: AdminResetUserPasswordRequest) {
          return yield* adminResetUserPassword({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
        adminInitiateAuth: Effect.fn(
          `AWS.Cognito.UserPoolAdmin.adminInitiateAuth(${logicalId})`,
        )(function* (request: AdminInitiateAuthRequest) {
          return yield* adminInitiateAuth({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
        adminRespondToAuthChallenge: Effect.fn(
          `AWS.Cognito.UserPoolAdmin.adminRespondToAuthChallenge(${logicalId})`,
        )(function* (request: AdminRespondToAuthChallengeRequest) {
          return yield* adminRespondToAuthChallenge({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
        adminUserGlobalSignOut: Effect.fn(
          `AWS.Cognito.UserPoolAdmin.adminUserGlobalSignOut(${logicalId})`,
        )(function* (request: AdminUserGlobalSignOutRequest) {
          return yield* adminUserGlobalSignOut({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
        adminAddUserToGroup: Effect.fn(
          `AWS.Cognito.UserPoolAdmin.adminAddUserToGroup(${logicalId})`,
        )(function* (request: AdminAddUserToGroupRequest) {
          return yield* adminAddUserToGroup({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
        adminRemoveUserFromGroup: Effect.fn(
          `AWS.Cognito.UserPoolAdmin.adminRemoveUserFromGroup(${logicalId})`,
        )(function* (request: AdminRemoveUserFromGroupRequest) {
          return yield* adminRemoveUserFromGroup({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
        listUsers: Effect.fn(
          `AWS.Cognito.UserPoolAdmin.listUsers(${logicalId})`,
        )(function* (request: ListUsersRequest = {}) {
          return yield* listUsers({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
        listUsersInGroup: Effect.fn(
          `AWS.Cognito.UserPoolAdmin.listUsersInGroup(${logicalId})`,
        )(function* (request: ListUsersInGroupRequest) {
          return yield* listUsersInGroup({
            ...request,
            UserPoolId: yield* UserPoolId,
          });
        }),
      };
      return adminClient;
    });
  }),
);
