import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as baremetalsolution from "@distilled.cloud/gcp/baremetalsolution_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

// Bare Metal Solution API is disabled on the default testing project
// (`Forbidden`: "Bare Metal Solution API has not been used in project
// alchemy-gcp-testing-83661 before or it is disabled."). Snapshots also
// require a boot volume. Set GCP_TEST_BAREMETALSOLUTION=1 and
// GCP_TEST_BAREMETALSOLUTION_VOLUME on an entitled project to run the
// full lifecycle.
const bootVolume = process.env.GCP_TEST_BAREMETALSOLUTION_VOLUME;
const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  process.env.GCP_TEST_BAREMETALSOLUTION === "1" &&
  !!bootVolume;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const missingVolume = (projectId: string) =>
  `projects/${projectId}/locations/us-central1/volumes/alchemy-missing-boot`;

const waitUntilGone = (name: string) =>
  baremetalsolution.getProjectsLocationsVolumesSnapshots({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsVolumesSnapshots on a missing snapshot fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        baremetalsolution.getProjectsLocationsVolumesSnapshots({
          name: `${missingVolume(project)}/snapshots/alchemy-bms-snap-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* baremetalsolution
        .listProjectsLocationsVolumesSnapshots({
          parent: `${missingVolume(project)}`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ volumeSnapshots: [] as const }),
          ),
        );
      expect(Array.isArray(page.volumeSnapshots ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || runLifecycle)(
  "create is rejected with Forbidden when the Bare Metal Solution API is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Baremetalsolution.VolumesSnapshot("Nightly", {
              volume: missingVolume(project),
              description: "alchemy-test-snap",
            });
          }),
        ),
      );
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toContain("has not been used in project");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a boot volume snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Baremetalsolution.VolumesSnapshot("Nightly", {
            volume: bootVolume!,
            description: "alchemy-test-snap",
          });
        }),
      );

      expect(created.name).toContain("/snapshots/");
      expect(created.snapshotId).toEqual(expect.any(String));
      expect(created.description).toEqual("alchemy-test-snap");

      const fetched =
        yield* baremetalsolution.getProjectsLocationsVolumesSnapshots({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("alchemy-test-snap");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
