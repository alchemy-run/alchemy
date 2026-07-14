import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";

import CognitoTestFunctionLive, { CognitoTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CognitoBindings");

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Retry transient 5xx only (cold re-init, IAM propagation); 4xx and
// assertion failures surface immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

const decodeJwtPayload = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));

describe("Cognito Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("Cognito test setup: destroying previous stack");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Cognito test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* CognitoTestFunction;
        }).pipe(Effect.provide(CognitoTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/config`;

      yield* Effect.logInfo(
        `Cognito test setup: probing readiness at ${readinessUrl}`,
      );
      yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Cognito test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
    }),
    { timeout: 240_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 120_000 });

  describe("UserPoolAuth", () => {
    test.provider(
      "USER_PASSWORD_AUTH returns valid Cognito JWTs",
      (_stack) =>
        Effect.gen(function* () {
          const config = (yield* send(
            HttpClientRequest.get(`${baseUrl}/config`),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            userPoolId: string;
            clientId: string;
          };
          expect(config.userPoolId).toMatch(/^[a-z0-9-]+_[A-Za-z0-9]+$/);

          const response = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/auth-flow?username=authflow-user`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            challengeName: string | undefined;
            idToken: string | undefined;
            accessToken: string | undefined;
            refreshToken: string | undefined;
            tokenType: string | undefined;
            getUserUsername: string | undefined;
          };

          expect(response.challengeName).toBeUndefined();
          expect(response.tokenType).toBe("Bearer");
          expect(response.idToken).toBeTruthy();
          expect(response.accessToken).toBeTruthy();
          expect(response.refreshToken).toBeTruthy();
          expect(response.getUserUsername).toBe("authflow-user");

          // The ID token must be a real Cognito JWT issued by our pool.
          const payload = decodeJwtPayload(response.idToken!);
          expect(payload.iss).toContain("cognito-idp.");
          expect(payload.iss).toContain(`/${config.userPoolId}`);
          expect(payload.token_use).toBe("id");
          expect(payload["cognito:username"]).toBe("authflow-user");
          expect(payload.aud).toBe(config.clientId);

          const accessPayload = decodeJwtPayload(response.accessToken!);
          expect(accessPayload.token_use).toBe("access");
          expect(accessPayload.client_id).toBe(config.clientId);
        }),
      { timeout: 120_000 },
    );

    test.provider(
      "signUp + adminConfirmSignUp enables password auth",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/sign-up-flow?username=signup-user`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            userConfirmed: boolean;
            userSub: string;
            confirmedStatus: string;
            hasIdToken: boolean;
          };

          expect(response.userConfirmed).toBe(false);
          expect(response.userSub).toBeTruthy();
          expect(response.confirmedStatus).toBe("CONFIRMED");
          expect(response.hasIdToken).toBe(true);
        }),
      { timeout: 120_000 },
    );
  });

  describe("UserPoolAdmin", () => {
    test.provider(
      "admin user lifecycle: create, disable, enable, groups, list, delete",
      (_stack) =>
        Effect.gen(function* () {
          const response = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/user-lifecycle?username=lifecycle-user`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            createdStatus: string;
            disabledEnabled: boolean;
            groupMembers: string[];
            listedCount: number;
            deleted: boolean;
          };

          expect(response.createdStatus).toBe("FORCE_CHANGE_PASSWORD");
          expect(response.disabledEnabled).toBe(false);
          expect(response.groupMembers).toContain("lifecycle-user");
          expect(response.listedCount).toBe(1);
          expect(response.deleted).toBe(true);
        }),
      { timeout: 120_000 },
    );
  });
});
