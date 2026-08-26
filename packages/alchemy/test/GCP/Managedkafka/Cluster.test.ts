import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
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
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_MANAGEDKAFKA;

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const waitUntilGone = (name: string) =>
  kafka.getProjectsLocationsClusters({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsClusters on a missing cluster fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        kafka.getProjectsLocationsClusters({
          name: `projects/${project}/locations/us-central1/clusters/alchemy-missing-kafka`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      const page = yield* kafka
        .listProjectsLocationsClusters({
          parent: `projects/${project}/locations/us-central1`,
          pageSize: 10,
        })
        .pipe(
          Effect.catchTag("Forbidden", () =>
            Effect.succeed({ clusters: [] as kafka.Cluster[] }),
          ),
        );
      expect(Array.isArray(page.clusters ?? [])).toEqual(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_MANAGEDKAFKA)(
  "createProjectsLocationsClusters is Forbidden when the API is disabled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        kafka.createProjectsLocationsClusters({
          parent: `projects/${project}/locations/us-central1`,
          clusterId: "alchemy-probe-kafka",
          body: {
            gcpConfig: {
              accessConfig: {
                networkConfigs: [
                  {
                    subnet: `projects/${project}/regions/us-central1/subnetworks/default`,
                  },
                ],
              },
            },
            capacityConfig: {
              vcpuCount: "3",
              memoryBytes: "3221225472",
            },
          },
        }),
      );
      expect(error._tag).toBe("Forbidden");
      expect(error.message).toContain(
        "Managed Service for Apache Kafka API has not been used",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a managed kafka cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Managedkafka.Cluster("Brokers", {
            location: "us-central1",
            capacityConfig: { vcpuCount: 3, memoryBytes: 3_221_225_472 },
            labels: { env: "test" },
          });
        }),
      );

      expect(created.name).toContain("/clusters/");
      expect(created.state).toEqual("ACTIVE");
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* kafka.getProjectsLocationsClusters({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.labels?.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Managedkafka.Cluster("Brokers", {
            clusterId: created.clusterId,
            location: "us-central1",
            capacityConfig: { vcpuCount: 3, memoryBytes: 3_221_225_472 },
            rebalanceConfig: { mode: "AUTO_REBALANCE_ON_SCALE_UP" },
            labels: { env: "prod" },
          });
        }),
      );
      expect(updated.clusterId).toEqual(created.clusterId);
      expect(updated.labels).toMatchObject({ env: "prod" });

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 240_000 },
);
