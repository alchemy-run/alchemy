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
  kafka.getProjectsLocationsClustersAcls({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsClustersAcls on a missing acl fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        kafka.getProjectsLocationsClustersAcls({
          name: `projects/${project}/locations/us-central1/clusters/alchemy-missing/acls/cluster`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a kafka acl",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.Managedkafka.Cluster("Brokers", {
            location: "us-central1",
            labels: { env: "test" },
          });
          const acl = yield* GCP.Managedkafka.ClustersAcl("OrdersAcl", {
            cluster: cluster.name,
            aclId: "topic/orders",
            aclEntries: [
              {
                principal: "User:*",
                operation: "DESCRIBE",
                permissionType: "ALLOW",
                host: "*",
              },
            ],
          });
          return { cluster, acl };
        }),
      );

      expect(created.acl.name).toContain("/acls/");
      expect(created.acl.aclId).toEqual("topic/orders");
      expect(created.acl.aclEntries.length).toBeGreaterThan(0);

      const fetched = yield* kafka.getProjectsLocationsClustersAcls({
        name: created.acl.name,
      });
      expect(fetched.name).toEqual(created.acl.name);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* GCP.Managedkafka.Cluster("Brokers", {
            clusterId: created.cluster.clusterId,
            location: "us-central1",
            labels: { env: "test" },
          });
          const acl = yield* GCP.Managedkafka.ClustersAcl("OrdersAcl", {
            cluster: cluster.name,
            aclId: "topic/orders",
            aclEntries: [
              {
                principal: "User:*",
                operation: "READ",
                permissionType: "ALLOW",
                host: "*",
              },
            ],
          });
          return { cluster, acl };
        }),
      );
      expect(updated.acl.aclId).toEqual("topic/orders");
      expect(
        updated.acl.aclEntries.some(
          (entry) => (entry.operation ?? "").toUpperCase() === "READ",
        ),
      ).toEqual(true);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.acl.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 240_000 },
);
