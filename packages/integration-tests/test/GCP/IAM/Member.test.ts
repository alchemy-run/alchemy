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

const bindingsFor = (bucket: string, member: string) =>
  storage
    .getIamPolicyBuckets({ bucket, optionsRequestedPolicyVersion: 3 })
    .pipe(
      Effect.map((policy) =>
        (policy.bindings ?? []).filter(
          (binding) => binding.role === ROLE && (binding.members ?? []).includes(member),
        ),
      ),
    );

test.provider(
  "grant, replace, and revoke a conditional bucket grant",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (prefix: string) =>
        Effect.gen(function* () {
          const bucket = yield* GCP.Storage.Bucket("ConditionalBucket", {
            uniformBucketLevelAccess: true,
            forceDestroy: true,
          });
          const account = yield* GCP.IAM.ServiceAccount("ConditionalReader", {});
          yield* GCP.IAM.Member("ConditionalRead", {
            kind: "storage.bucket",
            name: bucket.bucketName,
            role: ROLE,
            member: Output.interpolate`serviceAccount:${account.email}`,
            condition: {
              title: `only-${prefix}`,
              expression: Output.interpolate`resource.name.startsWith("projects/_/buckets/${bucket.bucketName}/objects/${prefix}/")`,
            },
          });
          return { bucket, account };
        });

      const first = yield* stack.deploy(program("logs"));
      const member = `serviceAccount:${first.account.email}`;

      const granted = yield* bindingsFor(first.bucket.bucketName, member);
      expect(granted.map((binding) => binding.condition?.title)).toEqual(["only-logs"]);

      // A new condition replaces the grant: the old conditional binding is gone.
      yield* stack.deploy(program("reports"));
      const replaced = yield* bindingsFor(first.bucket.bucketName, member);
      expect(replaced.map((binding) => binding.condition?.title)).toEqual(["only-reports"]);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:iam", "live"],
    timeout: 300_000,
  },
);
