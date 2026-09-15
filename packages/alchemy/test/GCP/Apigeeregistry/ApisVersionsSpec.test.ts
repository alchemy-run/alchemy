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
  openApi,
  probeTags,
  project,
  runLifecycle,
} from "./common.ts";

const noRetry = Layer.succeed(GcpRetry, { while: () => false });

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  registry.getProjectsLocationsApisVersionsSpecs({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsApisVersionsSpecs on a missing spec fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        registry
          .getProjectsLocationsApisVersionsSpecs({
            name: `projects/${project}/locations/${location}/apis/missing/versions/missing/specs/alchemy-missing`,
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
  "create, update, and delete an API spec",
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
          });
          const spec = yield* GCP.Apigeeregistry.ApisVersionsSpec("Openapi", {
            version: version.name,
            filename: "openapi.json",
            mimeType: "application/x.openapi+json;version=3.0.0",
            contents: openApi,
            labels: { env: "test" },
          });
          return { api, version, spec };
        }),
      );

      expect(created.spec.name).toContain("/specs/");
      expect(created.spec.version).toEqual(created.version.name);
      expect(created.spec.labels).toMatchObject({ env: "test" });

      const fetched = yield* registry.getProjectsLocationsApisVersionsSpecs({
        name: created.spec.name,
      });
      expect(fetched.name).toEqual(created.spec.name);
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
            displayName: "v1",
          });
          const spec = yield* GCP.Apigeeregistry.ApisVersionsSpec("Openapi", {
            version: version.name,
            specId: created.spec.specId,
            filename: "openapi.json",
            mimeType: "application/x.openapi+json;version=3.0.0",
            contents: openApi,
            description: "updated pets spec",
            labels: { env: "prod", role: "spec" },
          });
          return { api, version, spec };
        }),
      );

      expect(updated.spec.name).toEqual(created.spec.name);
      expect(updated.spec.labels).toMatchObject({ env: "prod", role: "spec" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.spec.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
