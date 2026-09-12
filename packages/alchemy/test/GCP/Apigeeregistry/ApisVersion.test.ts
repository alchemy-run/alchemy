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
  registry.getProjectsLocationsApisVersions({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsApisVersions on a missing version fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        registry
          .getProjectsLocationsApisVersions({
            name: `projects/${project}/locations/${location}/apis/missing/versions/alchemy-missing`,
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
  "create, update, and delete an API version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* GCP.Apigeeregistry.Api("Pets", {
            location,
            displayName: "pets",
          });
          const version = yield* GCP.Apigeeregistry.ApisVersion("V1", {
            api: api.name,
            displayName: "v1",
            state: "PRODUCTION",
            labels: { env: "test" },
          });
          return { api, version };
        }),
      );

      expect(created.version.name).toContain("/versions/");
      expect(created.version.displayName).toEqual("v1");
      expect(created.version.labels).toMatchObject({ env: "test" });

      const fetched = yield* registry.getProjectsLocationsApisVersions({
        name: created.version.name,
      });
      expect(fetched.name).toEqual(created.version.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* GCP.Apigeeregistry.Api("Pets", {
            apiId: created.api.apiId,
            location,
            displayName: "pets",
          });
          const version = yield* GCP.Apigeeregistry.ApisVersion("V1", {
            api: api.name,
            versionId: created.version.versionId,
            displayName: "v1-stable",
            state: "PRODUCTION",
            labels: { env: "prod", role: "version" },
          });
          return { api, version };
        }),
      );

      expect(updated.version.name).toEqual(created.version.name);
      expect(updated.version.displayName).toEqual("v1-stable");
      expect(updated.version.labels).toMatchObject({
        env: "prod",
        role: "version",
      });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.version.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
