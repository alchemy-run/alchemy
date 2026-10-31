import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as storagetransfer from "@distilled.cloud/gcp/storagetransfer_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const waitUntilGone = (jobName: string) =>
  Effect.gen(function* () {
    const { project } = yield* GcpEnvironment.current;

    return yield* storagetransfer.getTransferJobs({ jobName, projectId: project }).pipe(
      Effect.map((job) => (job.status === "DELETED" ? ("gone" as const) : ("found" as const))),
      Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (status) => status === "gone",
        times: 10,
      }),
    );
  });

test.provider(
  "create, update, and delete a transfer job",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GcpEnvironment.current;

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

      const created = yield* stack.deploy(
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
          return yield* GCP.StorageTransfer.TransferJob("Copy", {
            description: "copy uploads",
            status: "DISABLED",
            transferSpec: {
              gcsDataSource: { bucketName: buckets.sourceBucket },
              gcsDataSink: { bucketName: buckets.sinkBucket },
            },
          });
        }),
      );

      expect(created.jobId).toEqual(expect.any(String));
      expect(created.name).toEqual(`transferJobs/${created.jobId}`);
      expect(created.project).toEqual(project);
      expect(created.description).toEqual("copy uploads");

      // The provider granted the transfer agent read on the source and
      // write on the sink before the API validated them.
      const agent = yield* storagetransfer.getGoogleServiceAccounts({ projectId: project });
      const membersOf = (bucket: string, role: string) =>
        storage
          .getIamPolicyBuckets({ bucket })
          .pipe(
            Effect.map(
              (policy) => policy.bindings?.find((binding) => binding.role === role)?.members ?? [],
            ),
          );
      expect(yield* membersOf(buckets.sourceBucket, "roles/storage.objectViewer")).toContain(
        `serviceAccount:${agent.accountEmail}`,
      );
      expect(yield* membersOf(buckets.sinkBucket, "roles/storage.objectAdmin")).toContain(
        `serviceAccount:${agent.accountEmail}`,
      );
      expect(created.status).toEqual("DISABLED");
      expect(created.transferSpec?.gcsDataSource?.bucketName).toEqual(buckets.sourceBucket);
      expect(created.transferSpec?.gcsDataSink?.bucketName).toEqual(buckets.sinkBucket);

      const fetched = yield* storagetransfer.getTransferJobs({
        jobName: created.name,
        projectId: project,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.status).toEqual("DISABLED");
      expect(fetched.description).toContain("alchemy-id=");
      expect(fetched.description).toContain("copy uploads");
      expect(fetched.transferSpec?.gcsDataSource?.bucketName).toEqual(buckets.sourceBucket);

      const updated = yield* stack.deploy(
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
          return yield* GCP.StorageTransfer.TransferJob("Copy", {
            jobId: created.jobId,
            description: "copy inbox",
            status: "DISABLED",
            transferSpec: {
              gcsDataSource: {
                bucketName: buckets.sourceBucket,
                path: "inbox/",
              },
              gcsDataSink: { bucketName: buckets.sinkBucket },
            },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.jobId).toEqual(created.jobId);
      expect(updated.description).toEqual("copy inbox");
      expect(updated.transferSpec?.gcsDataSource?.path).toEqual("inbox/");

      const fetchedUpdate = yield* storagetransfer.getTransferJobs({
        jobName: created.name,
        projectId: project,
      });
      expect(fetchedUpdate.description).toContain("copy inbox");
      expect(fetchedUpdate.transferSpec?.gcsDataSource?.path).toEqual("inbox/");
      expect(fetchedUpdate.status).toEqual("DISABLED");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:storagetransfer", "live"],
    timeout: 120_000,
  },
);
