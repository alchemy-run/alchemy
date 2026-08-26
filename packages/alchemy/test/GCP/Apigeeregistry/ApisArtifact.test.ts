import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as registry from "@distilled.cloud/gcp/apigeeregistry_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  hasGcpCreds,
  location,
  logLevel,
  probeTags,
  project,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  registry.getProjectsLocationsApisArtifacts({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsApisArtifacts on a missing artifact fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        registry.getProjectsLocationsApisArtifacts({
          name: `projects/${project}/locations/${location}/apis/missing/artifacts/alchemy-missing`,
        }),
      );
      expect(probeTags).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an API artifact",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* GCP.Apigeeregistry.Api("Pets", {
            location,
            displayName: "pets",
          });
          const artifact = yield* GCP.Apigeeregistry.ApisArtifact("Manifest", {
            api: api.name,
            mimeType: "application/json",
            contents: JSON.stringify({ kind: "api-manifest" }),
            labels: { env: "test" },
          });
          return { api, artifact };
        }),
      );

      expect(created.artifact.name).toContain("/artifacts/");
      expect(created.artifact.parent).toEqual(created.api.name);
      expect(created.artifact.labels).toMatchObject({ env: "test" });

      const fetched = yield* registry.getProjectsLocationsApisArtifacts({
        name: created.artifact.name,
      });
      expect(fetched.name).toEqual(created.artifact.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const api = yield* GCP.Apigeeregistry.Api("Pets", {
            apiId: created.api.apiId,
            location,
            displayName: "pets",
          });
          const artifact = yield* GCP.Apigeeregistry.ApisArtifact("Manifest", {
            api: api.name,
            artifactId: created.artifact.artifactId,
            mimeType: "application/json",
            contents: JSON.stringify({ kind: "api-manifest", v: 2 }),
            labels: { env: "prod" },
          });
          return { api, artifact };
        }),
      );

      expect(updated.artifact.name).toEqual(created.artifact.name);
      expect(updated.artifact.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.artifact.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
