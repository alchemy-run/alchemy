import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const ROLE = "roles/storage.objectViewer";

const membersOf = (bucket: string) =>
  storage.getIamPolicyBuckets({ bucket, optionsRequestedPolicyVersion: 3 }).pipe(
    Effect.map((policy) =>
      (policy.bindings ?? [])
        .filter((binding) => binding.role === ROLE && binding.condition === undefined)
        .flatMap((binding) => binding.members ?? [])
        .sort(),
    ),
  );

test.provider(
  "own, shrink, and remove a role's members on a bucket",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (readers: ReadonlyArray<"first" | "second">) =>
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("BindingBucket", {
            uniformBucketLevelAccess: true,
            forceDestroy: true,
          });
          const first = yield* GCP.IAM.ServiceAccount("BindingFirst", {});
          const second = yield* GCP.IAM.ServiceAccount("BindingSecond", {});
          const accounts = { first, second };
          yield* GCP.IAM.Binding("Readers", {
            kind: "storage.bucket",
            name: bucket.bucketName,
            role: ROLE,
            members: readers.map(
              (reader) => Output.interpolate`serviceAccount:${accounts[reader].email}`,
            ),
          });
          return { bucket, first, second };
        });

      const both = yield* stack.deploy(program(["first", "second"]));
      const first = `serviceAccount:${both.first.email}`;
      const second = `serviceAccount:${both.second.email}`;
      expect(yield* membersOf(both.bucket.bucketName)).toEqual([first, second].sort());

      yield* stack.deploy(program(["second"]));
      expect(yield* membersOf(both.bucket.bucketName)).toEqual([second]);

      // Removing the Binding removes the role's unconditional binding.
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* GCP.Storage.Bucket("BindingBucket", {
            uniformBucketLevelAccess: true,
            forceDestroy: true,
          });
          yield* GCP.IAM.ServiceAccount("BindingFirst", {});
          yield* GCP.IAM.ServiceAccount("BindingSecond", {});
        }),
      );
      expect(yield* membersOf(both.bucket.bucketName)).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:iam", "live"], timeout: 300_000 },
);
