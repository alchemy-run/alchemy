import * as AWS from "@/AWS";
import { Cluster } from "@/AWS/DSQL";
import * as Test from "@/Test/Vitest";
import * as dsql from "@distilled.cloud/aws/dsql";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const getCluster = (identifier: string) =>
  dsql
    .getCluster({ identifier })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

test.provider(
  "create, update deletion protection, delete DSQL cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // create (deletion protection off for test economics)
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("AppDb", {
            tags: { app: "alchemy-test" },
          });
        }),
      );

      expect(created.clusterId).toBeDefined();
      expect(created.clusterArn).toContain(`:cluster/${created.clusterId}`);
      expect(["ACTIVE", "IDLE"]).toContain(created.status);
      expect(created.endpoint).toContain(created.clusterId);
      expect(created.deletionProtectionEnabled).toBe(false);

      // out-of-band verification
      const observed = yield* getCluster(created.clusterId);
      expect(observed?.identifier).toEqual(created.clusterId);
      expect(observed?.deletionProtectionEnabled).toBe(false);

      // update: enable deletion protection
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cluster("AppDb", {
            deletionProtectionEnabled: true,
            tags: { app: "alchemy-test" },
          });
        }),
      );
      expect(updated.clusterId).toEqual(created.clusterId);
      const reobserved = yield* getCluster(created.clusterId);
      expect(reobserved?.deletionProtectionEnabled).toBe(true);

      // delete (provider disables deletion protection automatically)
      yield* stack.destroy();
      const gone = yield* getCluster(created.clusterId);
      // A deleted DSQL cluster is either gone or reports DELETING/DELETED.
      expect(
        gone === undefined ||
          gone.status === "DELETING" ||
          gone.status === "DELETED",
      ).toBe(true);
    }),
  { timeout: 300_000 },
);
