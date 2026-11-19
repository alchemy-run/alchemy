import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as cloudfunctions from "@distilled.cloud/gcp/cloudfunctions_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { expectedEnv } from "../../EnvValues.ts";
import EnvFunction from "./fixtures/env-function.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

class NotReady extends Data.TaggedError("NotReady")<{ status: number }> {}

test.provider.skipIf(!!process.env.FAST)(
  "Cloud Functions deploys env values as process env strings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* EnvFunction;
          // Let the test call the function without an identity token.
          yield* GCP.IAM.Member("PublicInvoker", {
            kind: "run.service",
            name: fn.service.as<string>(),
            role: "roles/run.invoker",
            member: "allUsers",
          });
          return { name: fn.name, url: fn.url };
        }),
      );

      const client = yield* HttpClient.HttpClient;
      const env = yield* client.get(out.url!).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new NotReady({ status: response.status })),
        ),
        Effect.retry({
          while: (error) => error._tag === "NotReady",
          schedule: Schedule.spaced("5 seconds"),
          times: 18,
        }),
        Effect.flatMap((response) => response.json),
      );
      // Assert after destroy so a failure leaves nothing deployed.
      yield* stack.destroy();
      const gone = yield* cloudfunctions.getProjectsLocationsFunctions({ name: out.name }).pipe(
        Effect.as("found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      );
      expect(env).toEqual(expectedEnv);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:cloudfunctions", "live"], timeout: 900_000 },
);
