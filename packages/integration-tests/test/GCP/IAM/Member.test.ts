import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const viewer = "roles/storage.objectViewer";
const creator = "roles/storage.objectCreator";

/** A bucket, an account, and the account's grants on the bucket. */
const program = (options: { prefix?: string; unconditional?: boolean }) =>
  Effect.gen(function* () {
    const bucket = yield* GCP.Storage.Bucket("Data", {
      forceDestroy: true,
      // IAM Conditions need uniform bucket-level access.
      uniformBucketLevelAccess: true,
    });
    const reader = yield* GCP.IAM.ServiceAccount("Reader", { displayName: "Reader" });
    const member = Output.interpolate`serviceAccount:${reader.email}`;
    if (options.prefix !== undefined) {
      yield* GCP.IAM.Member("Prefix", {
        kind: "storage.bucket",
        name: bucket.bucketName,
        role: viewer,
        member,
        condition: {
          title: "one prefix",
          description: "objects under one prefix",
          expression: Output.interpolate`resource.name.startsWith("projects/_/buckets/${bucket.bucketName}/objects/${options.prefix}/")`,
        },
      });
    }
    if (options.unconditional) {
      // The same member under a second role, with no condition.
      yield* GCP.IAM.Member("Writer", {
        kind: "storage.bucket",
        name: bucket.bucketName,
        role: creator,
        member,
      });
    }
    return { bucket: bucket.bucketName, member };
  });

/** The bucket's bindings that name the member, read at the version that carries conditions. */
const bindingsOf = (deployed: { bucket: string; member: string }) =>
  storage
    .getIamPolicyBuckets({ bucket: deployed.bucket, optionsRequestedPolicyVersion: 3 })
    .pipe(
      Effect.map((policy) =>
        (policy.bindings ?? []).filter((binding) =>
          (binding.members ?? []).includes(deployed.member),
        ),
      ),
    );

test.provider(
  "grants a role under a condition, replaces it when the condition changes, and revokes it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // An unconditional grant beside a conditional one: each is its own binding.
      const created = yield* stack.deploy(program({ prefix: "public", unconditional: true }));
      const first = yield* bindingsOf(created).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (bindings) => bindings.length === 2,
          times: 10,
        }),
      );
      const conditional = first.find((binding) => binding.role === viewer);
      expect(conditional?.condition?.title).toBe("one prefix");
      expect(conditional?.condition?.description).toBe("objects under one prefix");
      expect(conditional?.condition?.expression).toBe(
        `resource.name.startsWith("projects/_/buckets/${created.bucket}/objects/public/")`,
      );
      expect(first.find((binding) => binding.role === creator)?.condition).toBeUndefined();

      // Nothing to do on an unchanged redeploy: the conditional grant reads as present.
      const plan = yield* stack.plan(program({ prefix: "public", unconditional: true }));
      expect(plan.resources.Prefix?.action).toBe("noop");
      expect(plan.resources.Writer?.action).toBe("noop");

      // A new expression is a new grant: the old binding goes, the other role stays.
      const moved = yield* stack.deploy(program({ prefix: "private", unconditional: true }));
      const second = yield* bindingsOf(moved);
      expect(second.filter((binding) => binding.role === viewer)).toHaveLength(1);
      expect(second.find((binding) => binding.role === viewer)?.condition?.expression).toBe(
        `resource.name.startsWith("projects/_/buckets/${moved.bucket}/objects/private/")`,
      );
      expect(second.find((binding) => binding.role === creator)?.condition).toBeUndefined();

      // Dropping the conditional grant leaves the unconditional one alone.
      const dropped = yield* stack.deploy(program({ unconditional: true }));
      const third = yield* bindingsOf(dropped);
      expect(third.map((binding) => binding.role)).toEqual([creator]);

      yield* stack.destroy();
      const gone = yield* storage.getBuckets({ bucket: created.bucket }).pipe(
        Effect.as("found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      );
      expect(gone).toBe("gone");
    }),
  { tags: ["provider:gcp", "provider:gcp:iam", "live"], timeout: 240_000 },
);
