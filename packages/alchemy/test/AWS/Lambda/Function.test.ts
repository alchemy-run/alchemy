import * as AWS from "@/AWS";
import * as Test from "@/Test/Vitest";
import * as Lambda from "@distilled.cloud/aws/lambda";
import { expect } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { TestFunction, TestFunctionLive } from "./handler.ts";

const timeoutHandlerPath = new URL("./timeout-handler.ts", import.meta.url)
  .pathname;

const { test } = Test.make({ providers: AWS.providers() });

test.provider(
  "create, update, delete function",
  (stack) =>
    Effect.gen(function* () {
      const { functionName, functionUrl } = yield* stack.deploy(
        TestFunction.pipe(Effect.provide(TestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();

      const response = yield* HttpClient.get(functionUrl!).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(
                new Error(`Function URL returned ${response.status}`),
              ),
        ),
        Effect.tapError((error) => Effect.logError(error)),
        Effect.retry({
          schedule: Schedule.exponential(500).pipe(
            Schedule.both(Schedule.recurs(10)),
          ),
        }),
      );

      expect(response.status).toBe(200);
      expect(yield* response.text).toBe("Hello, world!");

      const invokePolicy = yield* getPolicyStatement(
        functionName,
        "FunctionURLAllowPublicInvoke",
      );
      expect(invokePolicy.Condition).toEqual({
        Bool: {
          "lambda:InvokedViaFunctionUrl": "true",
        },
      });
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 180_000 },
);

test.provider(
  "applies and updates the Lambda timeout",
  (stack) =>
    Effect.gen(function* () {
      const initial = yield* stack.deploy(
        AWS.Lambda.Function<{}>()("TimeoutFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          url: false,
          timeout: Duration.seconds(15),
        }),
      );

      const initialConfig = yield* Lambda.getFunction({
        FunctionName: initial.functionName,
      });
      expect(initialConfig.Configuration?.Timeout).toBe(15);

      yield* stack.deploy(
        AWS.Lambda.Function<{}>()("TimeoutFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          url: false,
          timeout: Duration.seconds(45),
        }),
      );

      const updatedConfig = yield* Lambda.getFunction({
        FunctionName: initial.functionName,
      }).pipe(
        Effect.filterOrFail(
          (c) => c.Configuration?.Timeout === 45,
          () => new Error("Timeout update has not propagated yet"),
        ),
        Effect.retry({
          schedule: Schedule.exponential(500).pipe(
            Schedule.both(Schedule.recurs(10)),
          ),
        }),
      );
      expect(updatedConfig.Configuration?.Timeout).toBe(45);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 360_000 },
);

test.provider(
  "updates function URL auth to AWS_IAM",
  (stack) =>
    Effect.gen(function* () {
      const initial = yield* stack.deploy(
        AWS.Lambda.Function<{}>()("IamUrlFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          url: true,
        }),
      );

      const invokePolicy = yield* getPolicyStatement(
        initial.functionName,
        "FunctionURLAllowPublicInvoke",
      );
      expect(invokePolicy.Condition).toEqual({
        Bool: {
          "lambda:InvokedViaFunctionUrl": "true",
        },
      });

      const updated = yield* stack.deploy(
        AWS.Lambda.Function<{}>()("IamUrlFn", {
          main: timeoutHandlerPath,
          handler: "handler",
          isExternal: true,
          url: {
            authType: "AWS_IAM",
            cors: {
              AllowHeaders: ["authorization", "content-type"],
              AllowMethods: ["GET", "POST"],
              AllowOrigins: ["https://example.com"],
              ExposeHeaders: ["x-request-id"],
              MaxAge: 300,
            },
            invokeMode: "RESPONSE_STREAM",
          },
        }),
      );

      expect(updated.functionName).toBe(initial.functionName);
      expect(updated.functionUrl).toBeTruthy();

      const config = yield* getFunctionUrlConfigWithAuth(
        updated.functionName,
        "AWS_IAM",
      );
      expect(config.AuthType).toBe("AWS_IAM");
      expect(config.InvokeMode).toBe("RESPONSE_STREAM");
      expect(config.Cors).toEqual({
        AllowHeaders: ["authorization", "content-type"],
        AllowMethods: ["GET", "POST"],
        AllowOrigins: ["https://example.com"],
        ExposeHeaders: ["x-request-id"],
        MaxAge: 300,
      });

      yield* waitForPolicyStatementAbsent(
        updated.functionName,
        "FunctionURLAllowPublicAccess",
      );
      yield* waitForPolicyStatementAbsent(
        updated.functionName,
        "FunctionURLAllowPublicInvoke",
      );

      const response = yield* HttpClient.get(updated.functionUrl!).pipe(
        Effect.flatMap((response) =>
          response.status === 403
            ? Effect.succeed(response)
            : Effect.fail(
                new Error(`IAM Function URL returned ${response.status}`),
              ),
        ),
        Effect.retry({
          schedule: Schedule.exponential(500).pipe(
            Schedule.both(Schedule.recurs(10)),
          ),
        }),
      );
      expect(response.status).toBe(403);
    }).pipe(
      Effect.tap(() => stack.destroy()),
      Effect.onError(() => stack.destroy().pipe(Effect.ignore)),
    ),
  { timeout: 360_000 },
);

const getPolicyStatement = Effect.fn(function* (
  functionName: string,
  statementId: string,
) {
  return yield* findPolicyStatement(functionName, statementId).pipe(
    Effect.flatMap((statement) =>
      statement
        ? Effect.succeed(statement)
        : Effect.fail(new Error(`Policy statement ${statementId} not found`)),
    ),
    Effect.retry({
      schedule: Schedule.exponential(500).pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );
});

const waitForPolicyStatementAbsent = Effect.fn(function* (
  functionName: string,
  statementId: string,
) {
  yield* findPolicyStatement(functionName, statementId).pipe(
    Effect.flatMap((statement) =>
      statement
        ? Effect.fail(new Error(`Policy statement ${statementId} still exists`))
        : Effect.void,
    ),
    Effect.retry({
      schedule: Schedule.exponential(500).pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );
});

const findPolicyStatement = Effect.fn(function* (
  functionName: string,
  statementId: string,
) {
  return yield* Lambda.getPolicy({ FunctionName: functionName }).pipe(
    Effect.flatMap(({ Policy }) =>
      Effect.try({
        try: () => {
          const policy = JSON.parse(Policy ?? "{}") as {
            Statement?: Array<{
              Sid?: string;
              Condition?: unknown;
            }>;
          };
          return policy.Statement?.find(
            (statement) => statement.Sid === statementId,
          );
        },
        catch: (cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
      }),
    ),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );
});

const getFunctionUrlConfigWithAuth = Effect.fn(function* (
  functionName: string,
  authType: Lambda.FunctionUrlAuthType,
) {
  return yield* Lambda.getFunctionUrlConfig({
    FunctionName: functionName,
  }).pipe(
    Effect.filterOrFail(
      (config) => config.AuthType === authType,
      () => new Error("Function URL auth has not propagated yet"),
    ),
    Effect.retry({
      schedule: Schedule.exponential(500).pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );
});
