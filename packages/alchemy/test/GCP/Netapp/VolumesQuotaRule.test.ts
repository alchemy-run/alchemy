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
  netapp.getProjectsLocationsVolumesQuotaRules({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsVolumesQuotaRules on a missing rule fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        netapp.getProjectsLocationsVolumesQuotaRules({
          name: `projects/${project}/locations/us-central1/volumes/alchemy-missing-volume/quotaRules/alchemy-missing-rule`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* netapp
        .listProjectsLocationsVolumesQuotaRules({
          parent: `projects/${project}/locations/-/volumes/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed({ quotaRules: [] as const }),
          ),
        );
      expect(Array.isArray(page.quotaRules ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a quota rule",
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
          const volume = yield* GCP.Netapp.Volume("Share", {
            storagePool: pool.name,
            protocols: ["NFSV3"],
            capacityGib: 100,
            labels: { env: "test" },
          });
          return yield* GCP.Netapp.VolumesQuotaRule("DefaultUser", {
            volume: volume.name,
            type: "DEFAULT_USER_QUOTA",
            diskLimitMib: 1024,
            description: "alchemy-test-quota",
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/quotaRules/");
      expect(created.diskLimitMib).toEqual(1024);
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* netapp.getProjectsLocationsVolumesQuotaRules({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.diskLimitMib).toEqual(1024);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const pool = yield* GCP.Netapp.StoragePool("Pool", {
            network: "default",
            serviceLevel: "STANDARD",
            capacityGib: 2048,
            labels: { env: "test" },
          });
          const volume = yield* GCP.Netapp.Volume("Share", {
            storagePool: pool.name,
            protocols: ["NFSV3"],
            capacityGib: 100,
            labels: { env: "test" },
          });
          return yield* GCP.Netapp.VolumesQuotaRule("DefaultUser", {
            quotaRuleId: created.quotaRuleId,
            volume: volume.name,
            type: "DEFAULT_USER_QUOTA",
            diskLimitMib: 2048,
            description: "alchemy-prod-quota",
            labels: { env: "prod", role: "quota" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.diskLimitMib).toEqual(2048);
      expect(updated.description).toEqual("alchemy-prod-quota");
      expect(updated.labels).toMatchObject({ env: "prod", role: "quota" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
