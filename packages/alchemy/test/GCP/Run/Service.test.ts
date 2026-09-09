import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudrun from "@distilled.cloud/gcp/run_v2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { spawnSync } from "node:child_process";
import BoundRedisService from "./fixtures/service-redis.ts";
import BoundService from "./fixtures/service.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const dockerAvailable = (() => {
  try {
    return (
      spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 })
        .status === 0
    );
  } catch {
    return false;
  }
})();

const HELLO_IMAGE = "us-docker.pkg.dev/cloudrun/container/hello";

const waitUntilGone = (name: string) =>
  cloudrun.getProjectsLocationsServices({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a Cloud Run service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Run.Service("Api", {
            location: "us-central1",
            description: "test run service",
            labels: { env: "test" },
            template: {
              containers: [{ image: HELLO_IMAGE }],
            },
          });
        }),
      );

      expect(created.name).toContain("/services/");
      expect(created.serviceId).toEqual(expect.any(String));
      expect(created.location).toEqual("us-central1");
      expect(created.description).toEqual("test run service");
      expect(created.labels).toMatchObject({ env: "test" });
      expect(created.uri).toEqual(expect.any(String));
      expect(created.terminalConditionState).toEqual("CONDITION_SUCCEEDED");

      const fetched = yield* cloudrun.getProjectsLocationsServices({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.description).toEqual("test run service");
      expect(fetched.template?.containers?.[0]?.image).toEqual(HELLO_IMAGE);
      expect(fetched.uri).toEqual(created.uri);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Run.Service("Api", {
            serviceId: created.serviceId,
            location: "us-central1",
            description: "prod run service",
            labels: { env: "prod", role: "api" },
            ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY",
            template: {
              timeout: "60s",
              containers: [
                {
                  image: HELLO_IMAGE,
                  env: [{ name: "ENV", value: "prod" }],
                },
              ],
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("prod run service");
      expect(updated.labels).toMatchObject({ env: "prod", role: "api" });
      expect(updated.ingress).toEqual("INGRESS_TRAFFIC_INTERNAL_ONLY");
      expect(updated.uri).toEqual(expect.any(String));

      const refetched = yield* cloudrun.getProjectsLocationsServices({
        name: created.name,
      });
      expect(refetched.description).toEqual("prod run service");
      expect(refetched.labels?.env).toEqual("prod");
      expect(refetched.labels?.role).toEqual("api");
      expect(refetched.ingress).toEqual("INGRESS_TRAFFIC_INTERNAL_ONLY");
      expect(refetched.template?.timeout).toEqual("60s");
      expect(
        refetched.template?.containers?.[0]?.env?.some(
          (env) => env.name === "ENV" && env.value === "prod",
        ),
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

class ServiceNotReady extends Data.TaggedError("ServiceNotReady")<{
  status: number;
}> {}

test.provider.skipIf(!hasGcpCreds || !dockerAvailable)(
  "effect-native Function with PubSub and Storage bindings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const service = yield* BoundService;
          return { uri: service.uri };
        }),
      );

      expect(out.uri).toEqual(expect.any(String));
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get(out.uri!).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new ServiceNotReady({ status: response.status })),
        ),
        Effect.retry({
          while: (e): e is ServiceNotReady => e._tag === "ServiceNotReady",
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
      const body = (yield* res.json) as { published: boolean };
      expect(body.published).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider.skipIf(
  !hasGcpCreds || !dockerAvailable || !process.env.GCP_TEST_REDIS,
)(
  "effect-native Function with Memorystore Redis over Direct VPC",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const service = yield* BoundRedisService;
          return { uri: service.uri };
        }),
      );

      expect(out.uri).toEqual(expect.any(String));
      const client = yield* HttpClient.HttpClient;
      const res = yield* client.get(out.uri!).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new ServiceNotReady({ status: response.status })),
        ),
        Effect.retry({
          while: (e): e is ServiceNotReady => e._tag === "ServiceNotReady",
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );
      const body = (yield* res.json) as { redis: string | null };
      expect(body.redis).toEqual("ok");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 420_000 },
);
