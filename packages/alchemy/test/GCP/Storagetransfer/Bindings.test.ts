import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as storagetransfer from "@distilled.cloud/gcp/storagetransfer_v1";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const grantBucketRole = (bucket: string, member: string, role: string) =>
  Effect.gen(function* () {
    const policy = yield* storage.getIamPolicyBuckets({
      bucket,
      optionsRequestedPolicyVersion: 3,
    });
    const bindings = [...(policy.bindings ?? [])];
    const existing = bindings.find((binding) => binding.role === role);
    if (existing?.members?.includes(member)) return;
    if (existing) {
      existing.members = [...(existing.members ?? []), member];
    } else {
      bindings.push({ role, members: [member] });
    }
    yield* storage.setIamPolicyBuckets({
      bucket,
      body: {
        ...policy,
        bindings,
      },
    });
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 4,
      schedule: Schedule.spaced("500 millis"),
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "service account lookup and run job round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const buckets = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* GCP.Storage.Bucket("Src", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const sink = yield* GCP.Storage.Bucket("Dst", {
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          return {
            sourceBucket: source.bucketName.as<string>(),
            sinkBucket: sink.bucketName.as<string>(),
          };
        }),
      );

      const account = yield* storagetransfer.getGoogleServiceAccounts({
        projectId: project,
      });
      if (account.accountEmail) {
        const member = `serviceAccount:${account.accountEmail}`;
        yield* grantBucketRole(
          buckets.sourceBucket,
          member,
          "roles/storage.objectViewer",
        );
        yield* grantBucketRole(
          buckets.sourceBucket,
          member,
          "roles/storage.legacyBucketReader",
        );
        yield* grantBucketRole(
          buckets.sinkBucket,
          member,
          "roles/storage.legacyBucketReader",
        );
        yield* grantBucketRole(
          buckets.sinkBucket,
          member,
          "roles/storage.objectAdmin",
        );
        yield* grantBucketRole(
          buckets.sinkBucket,
          member,
          "roles/storage.legacyBucketWriter",
        );
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          yield* GCP.Storage.Bucket("Src", {
            bucketName: buckets.sourceBucket,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          yield* GCP.Storage.Bucket("Dst", {
            bucketName: buckets.sinkBucket,
            location: "US-CENTRAL1",
            forceDestroy: true,
          });
          const job = yield* GCP.Storagetransfer.TransferJob("Copy", {
            description: "binding probe",
            status: "ENABLED",
            transferSpec: {
              gcsDataSource: { bucketName: buckets.sourceBucket },
              gcsDataSink: { bucketName: buckets.sinkBucket },
            },
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* job.name;
              const getAccount =
                yield* GCP.Storagetransfer.GetGoogleServiceAccount(job);
              const runJob = yield* GCP.Storagetransfer.RunTransferJob(job);
              return Effect.fn(function* () {
                const sa = yield* getAccount();
                const started = yield* runJob().pipe(
                  Effect.retry({
                    while: (error) =>
                      error._tag === "Forbidden" || error._tag === "Conflict",
                    times: 8,
                    schedule: Schedule.exponential("500 millis"),
                  }),
                );
                const operation = started.name
                  ? yield* storagetransfer
                      .getTransferOperations({ name: started.name })
                      .pipe(
                        Effect.repeat({
                          schedule: Schedule.spaced("2 seconds"),
                          until: (current) => current.done === true,
                          times: 20,
                        }),
                      )
                  : started;
                return { sa, operation };
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(out.sa.accountEmail).toEqual(expect.any(String));
      expect(out.sa.accountEmail).toContain("@");
      expect(out.operation.name).toEqual(expect.any(String));

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
