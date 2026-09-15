import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as firebasedataconnect from "@distilled.cloud/gcp/firebasedataconnect_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  hasGcpCreds,
  location,
  logLevel,
  missingService,
  probeTags,
  project,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  firebasedataconnect.getProjectsLocationsServices({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds || runLifecycle)(
  "createProjectsLocationsServices is Forbidden when Firebase Data Connect is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        firebasedataconnect.createProjectsLocationsServices({
          parent: `projects/${project}/locations/${location}`,
          serviceId: "alchemy-fdc-probe",
          body: {
            displayName: "alchemy probe",
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toContain(
        "Firebase SQL Connect API has not been used",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsServices on a missing service fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        firebasedataconnect.getProjectsLocationsServices({
          name: missingService(),
        }),
      );
      expect(probeTags).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a firebase data connect service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firebasedataconnect.Service("Notes", {
            location,
            displayName: "notes",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/services/");
      expect(created.displayName).toEqual("notes");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* firebasedataconnect.getProjectsLocationsServices({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firebasedataconnect.Service("Notes", {
            serviceId: created.serviceId,
            location,
            displayName: "notes-v2",
            labels: { env: "prod", role: "fdc" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("notes-v2");

      yield* stack.destroy();
      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);
