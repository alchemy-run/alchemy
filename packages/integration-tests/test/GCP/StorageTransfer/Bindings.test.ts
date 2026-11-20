import * as GCP from "@alchemy.run/gcp";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import * as storagetransfer from "@distilled.cloud/gcp/storagetransfer_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { expectProbe } from "../bindingHost.ts";
import StorageTransferBindingsHost, {
  Copy,
  SEED_KEY,
  SEED_TEXT,
  Sink,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "StorageTransferBindings");

let baseUrl: string;
let hostAccount: string;
let project: string;
let jobName: string;
let sinkBucket: string;
let transferAccount: string;

/** Project-level roles held by the host's service account. */
const projectRoles = () =>
  resourcemanager
    .getIamPolicyProjects({
      resource: `projects/${project}`,
      body: { options: { requestedPolicyVersion: 3 } },
    })
    .pipe(
      Effect.map((policy) =>
        (policy.bindings ?? [])
          .filter((binding) => (binding.members ?? []).includes(`serviceAccount:${hostAccount}`))
          .map((binding) => ({
            role: binding.role,
            condition: binding.condition?.expression,
          }))
          .sort((a, b) => (a.role ?? "").localeCompare(b.role ?? "")),
      ),
    );

describe(
  "StorageTransfer Bindings",
  {
    tags: ["provider:gcp", "provider:gcp:storagetransfer", "provider:gcp:run", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* StorageTransferBindingsHost;
            const job = yield* Copy;
            const sink = yield* Sink;
            return {
              sink: sink.bucketName,
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              project: host.project,
              job: job.name,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        project = out.project;
        jobName = out.job;
        sinkBucket = out.sink;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("GetGoogleServiceAccount", () => {
      test.provider(
        "returns the project's transfer agent as the host",
        (_stack) =>
          Effect.gen(function* () {
            const out = yield* expectProbe<{ accountEmail: string }>(
              baseUrl,
              "getGoogleServiceAccount",
            );
            const account = yield* storagetransfer.getGoogleServiceAccounts({
              projectId: project,
            });
            expect(out.accountEmail).toEqual(account.accountEmail);
            expect(out.accountEmail).toMatch(
              /^project-\d+@storage-transfer-service\.iam\.gserviceaccount\.com$/,
            );
            expect(yield* projectRoles()).toContainEqual({
              role: "roles/storagetransfer.viewer",
              condition: undefined,
            });
          }),
        {
          tags: ["provider:gcp", "provider:gcp:storagetransfer", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("RunTransferJob", () => {
      test.provider(
        "runs the bound job as the host and the object lands in the sink",
        (_stack) =>
          Effect.gen(function* () {
            const started = yield* expectProbe<{ name: string }>(baseUrl, "runTransferJob");
            expect(started.name).toMatch(/^transferOperations\//);

            const operation = yield* storagetransfer
              .getTransferOperations({ name: started.name })
              .pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("5 seconds"),
                  until: (current) => current.done === true,
                  times: 30,
                }),
              );
            expect(operation.done).toEqual(true);
            expect(operation.error).toEqual(undefined);
            expect(operation.metadata?.transferJobName).toEqual(jobName);

            const copied = yield* storage.getObjects({
              bucket: sinkBucket,
              object: SEED_KEY,
            });
            expect(copied.size).toEqual(String(SEED_TEXT.length));

            expect(yield* projectRoles()).toEqual([
              { role: "roles/storagetransfer.user", condition: undefined },
              { role: "roles/storagetransfer.viewer", condition: undefined },
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:storagetransfer", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
