import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as registry from "@distilled.cloud/gcp/apigeeregistry_v1";
import { Retry as GcpRetry } from "@distilled.cloud/gcp/Retry";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import {
  hasGcpCreds,
  location,
  logLevel,
  probeTags,
  project,
  runLifecycle,
} from "./common.ts";

const noRetry = Layer.succeed(GcpRetry, { while: () => false });

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  registry.getProjectsLocationsApis({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsApis on a missing API fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        registry
          .getProjectsLocationsApis({
            name: `projects/${project}/locations/${location}/apis/alchemy-missing-api`,
          })
          .pipe(Effect.provide(noRetry)),
      );
      expect([
        ...probeTags,
        "UnknownGCPError",
        "BadGateway",
        "ServiceUnavailable",
        "GatewayTimeout",
      ]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an API",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigeeregistry.Api("Pets", {
            location,
            displayName: "pets",
            description: "alchemy pets api",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/apis/");
      expect(created.displayName).toEqual("pets");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* registry.getProjectsLocationsApis({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigeeregistry.Api("Pets", {
            apiId: created.apiId,
            location,
            displayName: "pets-v2",
            description: "updated alchemy pets api",
            labels: { env: "prod", role: "api" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("pets-v2");
      expect(updated.labels).toMatchObject({ env: "prod", role: "api" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
