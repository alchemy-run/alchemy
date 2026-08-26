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
  registry.getProjectsLocationsArtifacts({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsArtifacts on a missing artifact fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        registry.getProjectsLocationsArtifacts({
          name: `projects/${project}/locations/${location}/artifacts/alchemy-missing-artifact`,
        }),
      );
      expect(probeTags).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a location artifact",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigeeregistry.Artifact("Manifest", {
            location,
            mimeType: "application/json",
            contents: JSON.stringify({ kind: "manifest" }),
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/artifacts/");
      expect(created.location).toEqual(location);
      expect(created.mimeType).toEqual("application/json");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* registry.getProjectsLocationsArtifacts({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");
      expect(fetched.labels?.["alchemy-id"]).toEqual(expect.any(String));

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Apigeeregistry.Artifact("Manifest", {
            artifactId: created.artifactId,
            location,
            mimeType: "application/json",
            contents: JSON.stringify({ kind: "manifest", v: 2 }),
            labels: { env: "prod", role: "manifest" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.labels).toMatchObject({ env: "prod", role: "manifest" });

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
