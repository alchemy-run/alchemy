import * as Cognito from "@/AWS/Cognito";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

const plain = (
  value: string | Redacted.Redacted<string> | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : typeof value === "string"
      ? value
      : Redacted.value(value);

const PASSWORD = "Alchemy-Test-Passw0rd!";

export class CognitoTestFunction extends Lambda.Function<Lambda.Function>()(
  "CognitoTestFunction",
) {}

export default CognitoTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const pool = yield* Cognito.UserPool("BindingsUserPool", {
      passwordPolicy: {
        minimumLength: 12,
        requireSymbols: false,
      },
      accountRecovery: [{ name: "admin_only", priority: 1 }],
      tags: { Purpose: "cognito-bindings-fixture" },
    });
    const client = yield* Cognito.UserPoolClient("BindingsUserPoolClient", {
      userPoolId: pool.userPoolId,
      explicitAuthFlows: [
        "ALLOW_USER_PASSWORD_AUTH",
        "ALLOW_ADMIN_USER_PASSWORD_AUTH",
        "ALLOW_REFRESH_TOKEN_AUTH",
      ],
    });
    const group = yield* Cognito.Group("BindingsGroup", {
      userPoolId: pool.userPoolId,
      description: "cognito bindings fixture group",
    });

    const admin = yield* Cognito.UserPoolAdmin(pool);
    const auth = yield* Cognito.UserPoolAuth(client);
    // Output → deferred effect; resolved per-request inside the handler.
    const GroupName = yield* group.groupName;
    const UserPoolId = yield* pool.userPoolId;
    const ClientId = yield* client.clientId;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;
        const username = url.searchParams.get("username") ?? "missing-user";

        // Full password auth flow: create → set permanent password →
        // USER_PASSWORD_AUTH → getUser with the access token → delete.
        if (request.method === "POST" && pathname === "/auth-flow") {
          yield* admin
            .adminCreateUser({
              Username: username,
              MessageAction: "SUPPRESS",
              UserAttributes: [
                { Name: "email", Value: `${username}@example.com` },
                { Name: "email_verified", Value: "true" },
              ],
            })
            .pipe(
              // rerun tolerance: an earlier partial run may have left the user
              Effect.catchTag("UsernameExistsException", () => Effect.void),
            );
          yield* admin.adminSetUserPassword({
            Username: username,
            Password: PASSWORD,
            Permanent: true,
          });
          const signIn = yield* auth.initiateAuth({
            AuthFlow: "USER_PASSWORD_AUTH",
            AuthParameters: { USERNAME: username, PASSWORD },
          });
          const accessToken = plain(signIn.AuthenticationResult?.AccessToken);
          const me = accessToken
            ? yield* auth.getUser({ AccessToken: accessToken })
            : undefined;
          yield* admin.adminDeleteUser({ Username: username });
          return yield* HttpServerResponse.json({
            challengeName: signIn.ChallengeName,
            idToken: plain(signIn.AuthenticationResult?.IdToken),
            accessToken,
            refreshToken: plain(signIn.AuthenticationResult?.RefreshToken),
            tokenType: signIn.AuthenticationResult?.TokenType,
            getUserUsername: plain(me?.Username),
          });
        }

        // Admin user lifecycle: create → get → disable → enable → group
        // membership → list → delete.
        if (request.method === "POST" && pathname === "/user-lifecycle") {
          yield* admin
            .adminCreateUser({
              Username: username,
              MessageAction: "SUPPRESS",
              UserAttributes: [
                { Name: "email", Value: `${username}@example.com` },
              ],
            })
            .pipe(
              Effect.catchTag("UsernameExistsException", () => Effect.void),
            );
          const created = yield* admin.adminGetUser({ Username: username });
          yield* admin.adminDisableUser({ Username: username });
          const disabled = yield* admin.adminGetUser({ Username: username });
          yield* admin.adminEnableUser({ Username: username });
          const groupName = yield* GroupName;
          yield* admin.adminAddUserToGroup({
            Username: username,
            GroupName: groupName,
          });
          const inGroup = yield* admin.listUsersInGroup({
            GroupName: groupName,
          });
          yield* admin.adminRemoveUserFromGroup({
            Username: username,
            GroupName: groupName,
          });
          const listed = yield* admin.listUsers({
            Filter: `username = "${username}"`,
          });
          yield* admin.adminDeleteUser({ Username: username });
          const gone = yield* admin.adminGetUser({ Username: username }).pipe(
            Effect.map(() => false),
            Effect.catchTag("UserNotFoundException", () =>
              Effect.succeed(true),
            ),
          );
          return yield* HttpServerResponse.json({
            createdStatus: created.UserStatus,
            disabledEnabled: disabled.Enabled,
            groupMembers: (inGroup.Users ?? []).map((u) => plain(u.Username)),
            listedCount: (listed.Users ?? []).length,
            deleted: gone,
          });
        }

        // Public sign-up (admin-confirmed since we cannot receive the email
        // code) followed by password auth.
        if (request.method === "POST" && pathname === "/sign-up-flow") {
          const signedUp = yield* auth
            .signUp({
              Username: username,
              Password: PASSWORD,
              UserAttributes: [
                { Name: "email", Value: `${username}@example.com` },
              ],
            })
            .pipe(
              Effect.map((r) => ({
                userConfirmed: r.UserConfirmed,
                userSub: r.UserSub,
              })),
              Effect.catchTag("UsernameExistsException", () =>
                Effect.succeed({
                  userConfirmed: false,
                  userSub: "already-exists",
                }),
              ),
            );
          yield* admin.adminConfirmSignUp({ Username: username }).pipe(
            // NotAuthorizedException: already CONFIRMED on rerun
            Effect.catchTag("NotAuthorizedException", () => Effect.void),
          );
          const confirmed = yield* admin.adminGetUser({ Username: username });
          const signIn = yield* auth.initiateAuth({
            AuthFlow: "USER_PASSWORD_AUTH",
            AuthParameters: { USERNAME: username, PASSWORD },
          });
          yield* admin.adminDeleteUser({ Username: username });
          return yield* HttpServerResponse.json({
            userConfirmed: signedUp.userConfirmed,
            userSub: signedUp.userSub,
            confirmedStatus: confirmed.UserStatus,
            hasIdToken: signIn.AuthenticationResult?.IdToken !== undefined,
          });
        }

        if (request.method === "GET" && pathname === "/config") {
          return yield* HttpServerResponse.json({
            ok: true,
            userPoolId: yield* UserPoolId,
            clientId: yield* ClientId,
          });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cognito.UserPoolAdminHttp, Cognito.UserPoolAuthHttp),
    ),
  ),
);
