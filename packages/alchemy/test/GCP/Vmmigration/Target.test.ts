import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as vmmigration from "@distilled.cloud/gcp/vmmigration_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  hasGcpCreds,
  logLevel,
  project,
  runEntitlementProbe,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsTargetProjects on a missing target fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmmigration.getProjectsLocationsTargetProjects({
          name: `projects/${project}/locations/global/targetProjects/alchemy-missing-target`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runEntitlementProbe)(
  "createProjectsLocationsTargetProjects without entitlement fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmmigration.createProjectsLocationsTargetProjects({
          parent: `projects/${project}/locations/global`,
          targetProjectId: "alchemy-target-probe",
          body: {
            project,
            description: "alchemy entitlement probe",
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a vm migration target project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Vmmigration.Target("Landing", {
            project,
            description: "landing zone",
          });
        }),
      );

      expect(created.targetProjectId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/locations/global/targetProjects/${created.targetProjectId}`,
      );
      expect(created.location).toEqual("global");
      expect(created.project).toEqual(project);
      expect(created.description).toEqual("landing zone");

      const fetched = yield* vmmigration.getProjectsLocationsTargetProjects({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.project).toEqual(project);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("landing zone");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Vmmigration.Target("Landing", {
            targetProjectId: created.targetProjectId,
            project,
            description: "landing zone v2",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("landing zone v2");

      const fetchedUpdate =
        yield* vmmigration.getProjectsLocationsTargetProjects({
          name: updated.name,
        });
      expect(fetchedUpdate.description).toContain("landing zone v2");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        vmmigration.getProjectsLocationsTargetProjects({ name: created.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
