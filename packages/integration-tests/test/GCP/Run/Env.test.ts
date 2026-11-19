import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { expectedEnv } from "../../EnvValues.ts";
import EnvService from "./fixtures/env-service.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class NotReady extends Data.TaggedError("NotReady")<{ status: number }> {}

test.provider(
  "Cloud Run deploys env values as process env strings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const service = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* EnvService;
        }),
      );

      const client = yield* HttpClient.HttpClient;
      const env = yield* client.get(service.uri!).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new NotReady({ status: response.status })),
        ),
        Effect.retry({
          while: (e) => e._tag === "NotReady",
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
        Effect.flatMap((response) => response.json),
      );
      // Assert after destroy so a failure leaves nothing deployed.
      yield* stack.destroy();
      const gone = yield* cloudrun.getProjectsLocationsServices({ name: service.name }).pipe(
        Effect.as("found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (status) => status === "gone",
          times: 10,
        }),
      );
      expect(env).toEqual(expectedEnv);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:run", "live"], timeout: 900_000 },
);
