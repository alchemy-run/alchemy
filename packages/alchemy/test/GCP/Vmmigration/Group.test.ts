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
  "getProjectsLocationsGroups on a missing group fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmmigration.getProjectsLocationsGroups({
          name: `projects/${project}/locations/us-central1/groups/alchemy-missing-group`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runEntitlementProbe)(
  "createProjectsLocationsGroups without entitlement fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        vmmigration.createProjectsLocationsGroups({
          parent: `projects/${project}/locations/us-central1`,
          groupId: "alchemy-group-probe",
          body: {
            displayName: "probe",
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
  "create, update, and delete a vm migration group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Vmmigration.Group("Workloads", {
            location: "us-central1",
            displayName: "workloads",
            description: "production vms",
          });
        }),
      );

      expect(created.groupId).toEqual(expect.any(String));
      expect(created.name).toEqual(
        `projects/${project}/locations/us-central1/groups/${created.groupId}`,
      );
      expect(created.location).toEqual("us-central1");
      expect(created.displayName).toEqual("workloads");
      expect(created.description).toEqual("production vms");

      const fetched = yield* vmmigration.getProjectsLocationsGroups({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toEqual("workloads");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("production vms");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Vmmigration.Group("Workloads", {
            groupId: created.groupId,
            location: "us-central1",
            displayName: "workloads-v2",
            description: "production vms v2",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("workloads-v2");
      expect(updated.description).toEqual("production vms v2");

      const fetchedUpdate = yield* vmmigration.getProjectsLocationsGroups({
        name: updated.name,
      });
      expect(fetchedUpdate.displayName).toEqual("workloads-v2");
      expect(fetchedUpdate.description).toContain("production vms v2");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(
        vmmigration.getProjectsLocationsGroups({ name: created.name }),
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
