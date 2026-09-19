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
  registry.getProjectsLocationsApisVersionsArtifacts({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsApisVersionsArtifacts on a missing artifact fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        registry.getProjectsLocationsApisVersionsArtifacts({
          name: `projects/${project}/locations/${location}/apis/missing/versions/missing/artifacts/alchemy-missing`,
        }),
      );
      expect(probeTags).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a version artifact",
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
          });
          const artifact = yield* GCP.Apigeeregistry.ApisVersionsArtifact(
            "Manifest",
            {
              version: version.name,
              mimeType: "application/json",
              contents: JSON.stringify({ kind: "version-manifest" }),
              labels: { env: "test" },
            },
          );
          return { api, version, artifact };
        }),
      );

      expect(created.artifact.name).toContain("/artifacts/");
      expect(created.artifact.parent).toEqual(created.version.name);
      expect(created.artifact.labels).toMatchObject({ env: "test" });

      const fetched = yield* registry.getProjectsLocationsApisVersionsArtifacts(
        {
          name: created.artifact.name,
        },
      );
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
          const version = yield* GCP.Apigeeregistry.ApisVersion("V1", {
            api: api.name,
            versionId: created.version.versionId,
            displayName: "v1",
            state: "PRODUCTION",
          });
          const artifact = yield* GCP.Apigeeregistry.ApisVersionsArtifact(
            "Manifest",
            {
              version: version.name,
              artifactId: created.artifact.artifactId,
              mimeType: "application/json",
              contents: JSON.stringify({ kind: "version-manifest", v: 2 }),
              labels: { env: "prod" },
            },
          );
          return { api, version, artifact };
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
