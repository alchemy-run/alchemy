/**
 * `AWS.S3.Bucket` under `alchemy dev`, against the floci emulator.
 *
 * The managed emulator keeps its data in memory, so a Docker restart
 * empties it while local state still records every resource (#2724). The
 * test deletes a bucket and a role out of band from the emulator, which is
 * what a restart does to them, and redeploys: both come back under their
 * old names instead of failing with `NoSuchBucket` (the bucket) or planning
 * "no change" (the role).
 *
 * Requires Docker (floci runs as a container).
 */
import * as AWS from "@alchemy.run/aws";
import { flociServices } from "@alchemy.run/aws/Local/FlociServices";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers(), dev: true });

const assumeRolePolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "lambda.amazonaws.com" },
      Action: ["sts:AssumeRole"],
    },
  ],
};

const resources = Effect.gen(function* () {
  const bucket = yield* AWS.S3.Bucket("RestartBucket", {
    versioning: "Enabled",
    tags: { purpose: "restart" },
  });
  const role = yield* AWS.IAM.Role("RestartRole", {
    assumeRolePolicyDocument: assumeRolePolicy,
  });
  return { bucket, role };
});

const bucketExists = (bucketName: string) =>
  S3.headBucket({ Bucket: bucketName }).pipe(
    Effect.as(true),
    Effect.catchTag(["NotFound", "NoSuchBucket"], () => Effect.succeed(false)),
    Effect.provide(flociServices()),
  );

const roleExists = (roleName: string) =>
  IAM.getRole({ RoleName: roleName }).pipe(
    Effect.as(true),
    Effect.catchTag("NoSuchEntityException", () => Effect.succeed(false)),
    Effect.provide(flociServices()),
  );

test.provider(
  "recreates a bucket and role the emulator lost",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(resources);
      expect(deployed.bucket.bucketArn).toBeDefined();
      expect(deployed.role.roleArn).toContain(":000000000000:");

      // What a restarted emulator does: the resources are gone, local
      // state still records them.
      yield* S3.deleteBucket({ Bucket: deployed.bucket.bucketName }).pipe(
        Effect.provide(flociServices()),
      );
      yield* IAM.deleteRole({ RoleName: deployed.role.roleName }).pipe(
        Effect.provide(flociServices()),
      );
      expect(yield* bucketExists(deployed.bucket.bucketName)).toBe(false);
      expect(yield* roleExists(deployed.role.roleName)).toBe(false);

      const plan = yield* stack.plan(resources);
      expect(plan.resources.RestartBucket?.action).toBe("update");
      expect(plan.resources.RestartRole?.action).toBe("update");

      const redeployed = yield* stack.deploy(resources);
      expect(redeployed.bucket.bucketName).toBe(deployed.bucket.bucketName);
      expect(redeployed.role.roleName).toBe(deployed.role.roleName);

      // Recreated with their configuration, not as bare resources.
      const versioning = yield* S3.getBucketVersioning({
        Bucket: redeployed.bucket.bucketName,
      }).pipe(Effect.provide(flociServices()));
      expect(versioning.Status).toBe("Enabled");
      const tagging = yield* S3.getBucketTagging({
        Bucket: redeployed.bucket.bucketName,
      }).pipe(Effect.provide(flociServices()));
      expect(tagging.TagSet).toContainEqual({ Key: "purpose", Value: "restart" });
      expect(yield* roleExists(redeployed.role.roleName)).toBe(true);

      // Converged: nothing left to do.
      const settled = yield* stack.plan(resources);
      expect(settled.resources.RestartBucket?.action).toBe("noop");
      expect(settled.resources.RestartRole?.action).toBe("noop");

      yield* stack.destroy();
      expect(yield* bucketExists(redeployed.bucket.bucketName)).toBe(false);
      expect(yield* roleExists(redeployed.role.roleName)).toBe(false);
    }),
  {
    tags: ["provider:aws", "provider:aws:s3", "local"],
    timeout: 180_000,
  },
);
