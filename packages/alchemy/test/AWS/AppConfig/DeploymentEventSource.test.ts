import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { describe } from "vitest";

import AppConfigEventsTestFunctionLive, {
  AppConfigEventsTestFunction,
} from "./fixtures/events-handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "AppConfigEvents");

let baseUrl: string;

interface EventBody {
  event: {
    InvocationId?: string;
    Type?: string;
    DeploymentNumber?: number;
    Environment?: { Id?: string };
  } | null;
}

describe("AppConfig DeploymentEventSource", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "AppConfig event source setup: destroying previous resources",
      );
      yield* sharedStack.destroy();

      yield* Effect.logInfo(
        "AppConfig event source setup: deploying app -> env -> extension -> Lambda",
      );
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* AppConfigEventsTestFunction;
        }).pipe(Effect.provide(AppConfigEventsTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");

      // Readiness probe — fresh function URLs take seconds to serve 200s.
      yield* HttpClient.get(`${baseUrl}/ping`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(75),
          ]),
        }),
      );
    }),
    { timeout: 300_000 },
  );
  afterAll(sharedStack.destroy(), { timeout: 300_000 });

  test.provider(
    "deployment notifications invoke the Lambda through the extension",
    () =>
      Effect.gen(function* () {
        // Trigger a deployment at runtime; the extension association was
        // provisioned at deploy time, so its ON_DEPLOYMENT_* actions fire.
        // A fresh invoke role can briefly reject with AccessDenied (500
        // through the handler's orDie); retry the first request.
        const started = yield* HttpClient.execute(
          HttpClientRequest.post(`${baseUrl}/deploy`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ version: "1" }),
          ),
        ).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? response.json
              : Effect.fail(new Error(`deploy failed: ${response.status}`)),
          ),
          Effect.map(
            (json) => json as { deploymentNumber?: number; state?: string },
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.exponential("2 seconds"),
              Schedule.recurs(8),
            ]),
          }),
        );
        expect(started.deploymentNumber).toBeGreaterThan(0);

        // Poll until the ON_DEPLOYMENT_COMPLETE notification lands (the
        // fixture persists each notification to S3 under a per-deployment
        // key, so delivery to any Lambda instance is observable here).
        const eventUrl = `${baseUrl}/event?number=${started.deploymentNumber}&type=OnDeploymentComplete`;
        const body = yield* HttpClient.get(eventUrl).pipe(
          Effect.flatMap((response) => response.json),
          Effect.map((json) => json as EventBody),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (json): boolean => json.event !== null,
            times: 36,
          }),
        );

        const complete = body.event;
        expect(complete).toBeDefined();
        expect(complete!.InvocationId).toBeTruthy();
        expect(complete!.DeploymentNumber).toBe(started.deploymentNumber);
      }),
    { timeout: 300_000 },
  );
});
