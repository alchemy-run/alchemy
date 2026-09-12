import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dataform from "@distilled.cloud/gcp/dataform_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { hasGcpCreds, logLevel, project, waitUntilGone } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsFolders on a missing folder fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dataform.getProjectsLocationsFolders({
          name: `projects/${project}/locations/us-central1/folders/alchemy-missing-folder`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a dataform folder",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataform.ProjectsLocationsFolder("Analytics", {
            location: "us-central1",
            displayName: "analytics",
          });
        }),
      );

      expect(created.name).toContain("/folders/");
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("analytics");

      const fetched = yield* dataform.getProjectsLocationsFolders({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("analytics");
      expect(fetched.displayName).toMatch(/\[alc(hemy)? /);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dataform.ProjectsLocationsFolder("Analytics", {
            location: "us-central1",
            displayName: "analytics-v2",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("analytics-v2");

      const fetchedUpdate = yield* dataform.getProjectsLocationsFolders({
        name: updated.name,
      });
      expect(fetchedUpdate.displayName).toContain("analytics-v2");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        dataform.getProjectsLocationsFolders({ name: created.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
