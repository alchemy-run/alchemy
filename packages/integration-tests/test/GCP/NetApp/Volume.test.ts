import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as netapp from "@distilled.cloud/gcp/netapp_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { withNetworkSlot } from "../networkQuota.ts";
import { NetAppNetwork } from "./fixtures/network.ts";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Volumes mount through Private Service Access to `netapp.servicenetworking.goog`,
// so the lifecycle builds its own network (see fixtures/network.ts). The 2 TiB
// STANDARD pool fills a region's default quota
// (StandardStoragePoolCapacityGiBPerRegion = 2048), so each suite creates its
// pool in a region of its own (`us-west1`). Pools take minutes to create, so
// `--fast` skips the lifecycle.
const runLifecycle = !process.env.FAST;

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

test.provider(
  "getProjectsLocationsVolumes on a missing volume fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

      yield* stack.destroy();

      const error = yield* Effect.flip(
        netapp.getProjectsLocationsVolumes({
          name: `projects/${project}/locations/us-central1/volumes/alchemy-netapp-missing`,
        }),
      );
      expect(error._tag).toEqual("NotFound");

      const page = yield* netapp.listProjectsLocationsVolumes({
        parent: `projects/${project}/locations/-`,
        pageSize: 10,
      });
      expect((page.volumes ?? []).map((item) => item.name)).not.toContain(
        `projects/${project}/locations/us-central1/volumes/alchemy-netapp-missing`,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:netapp", "live"], timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a volume",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* GCP.NetApp.StoragePool("Pool", {
            location: "us-west1",
            network: yield* NetAppNetwork,
            serviceLevel: "STANDARD",
            capacityGib: 2048,
            labels: { env: "test" },
          });
          return yield* GCP.NetApp.Volume("Share", {
            location: "us-west1",
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
          const pool = yield* GCP.NetApp.StoragePool("Pool", {
            location: "us-west1",
            network: yield* NetAppNetwork,
            serviceLevel: "STANDARD",
            capacityGib: 2048,
            labels: { env: "test" },
          });
          return yield* GCP.NetApp.Volume("Share", {
            location: "us-west1",
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
    }).pipe(withNetworkSlot, logLevel),
  { tags: ["provider:gcp", "provider:gcp:netapp", "live"], timeout: 900_000 },
);
