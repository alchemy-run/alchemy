import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as netapp from "@distilled.cloud/gcp/netapp_v1";
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

const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_NETAPP && !process.env.FAST;
const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  netapp.getProjectsLocationsVolumes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsVolumes on a missing volume fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        netapp.getProjectsLocationsVolumes({
          name: `projects/${project}/locations/us-central1/volumes/alchemy-netapp-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* netapp
        .listProjectsLocationsVolumes({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ volumes: [] as const }),
          ),
        );
      expect(Array.isArray(page.volumes ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a volume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* GCP.Netapp.StoragePool("Pool", {
            network: "default",
            serviceLevel: "STANDARD",
            capacityGib: 2048,
            labels: { env: "test" },
          });
          return yield* GCP.Netapp.Volume("Share", {
            storagePool: pool.name,
            protocols: ["NFSV3"],
            capacityGib: 100,
            description: "alchemy-test-volume",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/volumes/");
      expect(created.protocols).toContain("NFSV3");
      expect(created.capacityGib).toEqual("100");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* netapp.getProjectsLocationsVolumes({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* GCP.Netapp.StoragePool("Pool", {
            network: "default",
            serviceLevel: "STANDARD",
            capacityGib: 2048,
            labels: { env: "test" },
          });
          return yield* GCP.Netapp.Volume("Share", {
            volumeId: created.volumeId,
            storagePool: pool.name,
            protocols: ["NFSV3"],
            capacityGib: 100,
            description: "alchemy-prod-volume",
            labels: { env: "prod", role: "nfs" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("alchemy-prod-volume");
      expect(updated.labels).toMatchObject({ env: "prod", role: "nfs" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
