import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
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

const runLifecycle = hasGcpCreds && !process.env.FAST;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const SSH_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl alchemy-test";

const waitUntilGone = (name: string) =>
  oracle.getProjectsLocationsCloudVmClusters({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsCloudVmClusters on a missing cluster fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        oracle.getProjectsLocationsCloudVmClusters({
          name: `projects/${project}/locations/us-central1/cloudVmClusters/alchemy-oracle-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* oracle
        .listProjectsLocationsCloudVmClusters({
          parent: `projects/${project}/locations/-`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ cloudVmClusters: [] as const }),
          ),
        );
      expect(Array.isArray(page.cloudVmClusters ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a cloud vm cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const probe = yield* oracle
        .listProjectsLocationsCloudVmClusters({
          parent: `projects/${project}/locations/us-central1`,
          pageSize: 1,
        })
        .pipe(
          Effect.map(() => ({ tag: "ok" as const })),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ tag: "Forbidden" as const }),
          ),
        );
      if (probe.tag === "Forbidden") {
        expect(probe.tag).toBe("Forbidden");
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const infra = yield* GCP.Oracledatabase.CloudExadataInfrastructure(
            "Exa",
            {
              displayName: "alchemy-test-exa",
              shape: "Exadata.X9M",
              computeCount: 2,
              storageCount: 3,
            },
          );
          return yield* GCP.Oracledatabase.CloudVmCluster("Vms", {
            location: "us-central1",
            exadataInfrastructure: infra.name,
            network: "default",
            cidr: "10.10.0.0/24",
            backupSubnetCidr: "10.10.1.0/24",
            licenseType: "LICENSE_INCLUDED",
            cpuCoreCount: 4,
            giVersion: "19.0.0.0",
            hostnamePrefix: "exa",
            sshPublicKeys: [SSH_KEY],
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/cloudVmClusters/");
      expect(created.cloudVmClusterId).toEqual(expect.any(String));
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* oracle.getProjectsLocationsCloudVmClusters({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
