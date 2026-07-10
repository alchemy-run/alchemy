import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isFunction } from "../Lambda/Function.ts";
import {
  UserPoolAuth,
  type ConfirmForgotPasswordRequest,
  type ConfirmSignUpRequest,
  type ForgotPasswordRequest,
  type InitiateAuthRequest,
  type ResendConfirmationCodeRequest,
  type RespondToAuthChallengeRequest,
  type RevokeTokenRequest,
  type SignUpRequest,
  type UserPoolAuthClient,
} from "./UserPoolAuth.ts";
import type { UserPoolClient } from "./UserPoolClient.ts";

/**
 * HTTP implementation of {@link UserPoolAuth}. The public auth-flow
 * operations are unauthenticated (Cognito does not evaluate IAM for them),
 * so the deploy-time half only records the binding — no policy statements
 * are attached.
 */
export const UserPoolAuthHttp = Layer.effect(
  UserPoolAuth,
  Effect.gen(function* () {
    const signUp = yield* cip.signUp;
    const confirmSignUp = yield* cip.confirmSignUp;
    const resendConfirmationCode = yield* cip.resendConfirmationCode;
    const initiateAuth = yield* cip.initiateAuth;
    const respondToAuthChallenge = yield* cip.respondToAuthChallenge;
    const forgotPassword = yield* cip.forgotPassword;
    const confirmForgotPassword = yield* cip.confirmForgotPassword;
    const getUser = yield* cip.getUser;
    const globalSignOut = yield* cip.globalSignOut;
    const revokeToken = yield* cip.revokeToken;

    return Effect.fn(function* <C extends UserPoolClient>(client: C) {
      const ClientId = yield* client.clientId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFunction(host)) {
          // No IAM is required for the public auth flows; the binding is
          // recorded so the app client deploys before the function.
          yield* host.bind`Allow(${host}, AWS.Cognito.UserPoolAuth(${client}))`(
            { policyStatements: [] },
          );
        }
      }
      const logicalId = client.LogicalId;
      const authClient: UserPoolAuthClient = {
        signUp: Effect.fn(`AWS.Cognito.UserPoolAuth.signUp(${logicalId})`)(
          function* (request: SignUpRequest) {
            return yield* signUp({ ...request, ClientId: yield* ClientId });
          },
        ),
        confirmSignUp: Effect.fn(
          `AWS.Cognito.UserPoolAuth.confirmSignUp(${logicalId})`,
        )(function* (request: ConfirmSignUpRequest) {
          return yield* confirmSignUp({
            ...request,
            ClientId: yield* ClientId,
          });
        }),
        resendConfirmationCode: Effect.fn(
          `AWS.Cognito.UserPoolAuth.resendConfirmationCode(${logicalId})`,
        )(function* (request: ResendConfirmationCodeRequest) {
          return yield* resendConfirmationCode({
            ...request,
            ClientId: yield* ClientId,
          });
        }),
        initiateAuth: Effect.fn(
          `AWS.Cognito.UserPoolAuth.initiateAuth(${logicalId})`,
        )(function* (request: InitiateAuthRequest) {
          return yield* initiateAuth({
            ...request,
            ClientId: yield* ClientId,
          });
        }),
        respondToAuthChallenge: Effect.fn(
          `AWS.Cognito.UserPoolAuth.respondToAuthChallenge(${logicalId})`,
        )(function* (request: RespondToAuthChallengeRequest) {
          return yield* respondToAuthChallenge({
            ...request,
            ClientId: yield* ClientId,
          });
        }),
        forgotPassword: Effect.fn(
          `AWS.Cognito.UserPoolAuth.forgotPassword(${logicalId})`,
        )(function* (request: ForgotPasswordRequest) {
          return yield* forgotPassword({
            ...request,
            ClientId: yield* ClientId,
          });
        }),
        confirmForgotPassword: Effect.fn(
          `AWS.Cognito.UserPoolAuth.confirmForgotPassword(${logicalId})`,
        )(function* (request: ConfirmForgotPasswordRequest) {
          return yield* confirmForgotPassword({
            ...request,
            ClientId: yield* ClientId,
          });
        }),
        getUser: Effect.fn(`AWS.Cognito.UserPoolAuth.getUser(${logicalId})`)(
          function* (request: cip.GetUserRequest) {
            return yield* getUser(request);
          },
        ),
        globalSignOut: Effect.fn(
          `AWS.Cognito.UserPoolAuth.globalSignOut(${logicalId})`,
        )(function* (request: cip.GlobalSignOutRequest) {
          return yield* globalSignOut(request);
        }),
        revokeToken: Effect.fn(
          `AWS.Cognito.UserPoolAuth.revokeToken(${logicalId})`,
        )(function* (request: RevokeTokenRequest) {
          return yield* revokeToken({
            ...request,
            ClientId: yield* ClientId,
          });
        }),
      };
      return authClient;
    });
  }),
);
