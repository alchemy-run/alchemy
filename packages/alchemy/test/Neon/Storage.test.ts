import { Credential } from "@/Neon/Credential";
import { Project } from "@/Neon/Project";
import { providers } from "@/Neon/Providers";
import { storageLayer } from "@/Neon/Storage";
import * as Test from "@/Test/Alchemy";
import * as S3 from "@distilled.cloud/aws/s3";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { signStorageRead } from "./fixtures/StorageNative.ts";

const { test } = Test.make({ providers: providers() });

test.provider(
  "read scopes authorize S3 and write-only rejection is typed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { read, write, both } = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Project("StorageCredentialProject", {
            region: "aws-us-east-2",
          });
          const read = yield* Credential("Read", {
            project,
            scopes: ["storage:read"],
          });
          const write = yield* Credential("Write", {
            project,
            scopes: ["storage:write"],
          });
          const both = yield* Credential("Both", {
            project,
            scopes: ["storage:read", "storage:write"],
          });
          return { read, write, both };
        }),
      );
      const storage = yield* SDK.getProjectBranchStorage({
        project_id: read.projectId,
        branch_id: read.branchId,
      });
      for (const credential of [read, write, both]) {
        const response = yield* S3.listBuckets({}).pipe(
          Effect.provide(
            storageLayer({
              endpoint: storage.s3_endpoint,
              region: storage.region,
              accessKeyId: credential.tokenId,
              secretAccessKey: credential.s3SecretAccessKey,
            }),
          ),
          Effect.retry({
            while: (error) => error._tag === "AccessDeniedException",
            schedule: Schedule.spaced("500 millis"),
            times: 8,
          }),
          Effect.result,
        );
        const signed = yield* Effect.tryPromise(() =>
          signStorageRead({
            endpoint: storage.s3_endpoint,
            region: storage.region,
            accessKeyId: credential.tokenId,
            secretAccessKey: Redacted.value(credential.s3SecretAccessKey),
          }),
        );
        const native = yield* (yield* HttpClient.HttpClient).get(signed.url, {
          headers: signed.headers,
        });
        yield* Effect.log(
          `Neon scope ${credential.scopes.join(",")}: distilled=${Result.isSuccess(response) ? "ok" : response.failure._tag}; native=${native.status}`,
        );
        if (credential === write) {
          expect(native.status).toBe(403);
          expect(Result.isFailure(response)).toBe(true);
          if (Result.isFailure(response))
            expect(response.failure._tag).toBe("AccessDeniedException");
        } else {
          expect(native.status).toBe(200);
          expect(Result.isSuccess(response)).toBe(true);
        }
      }
      yield* stack.destroy();
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

// Neon currently returns AccessDeniedException: Access Denied. for storage:write-only ListBuckets.
test.provider.skipIf(!process.env.NEON_TEST_WRITE_IMPLIES_READ)(
  "documented storage:write implies reads",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { credential } = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* Project("WriteImpliesReadProject", {
            region: "aws-us-east-2",
          });
          return {
            credential: yield* Credential("Writer", {
              project,
              scopes: ["storage:write"],
            }),
          };
        }),
      );
      const storage = yield* SDK.getProjectBranchStorage({
        project_id: credential.projectId,
        branch_id: credential.branchId,
      });
      const result = yield* S3.listBuckets({}).pipe(
        Effect.provide(
          storageLayer({
            endpoint: storage.s3_endpoint,
            region: storage.region,
            accessKeyId: credential.tokenId,
            secretAccessKey: credential.s3SecretAccessKey,
          }),
        ),
      );
      expect(result.Buckets ?? []).toEqual([]);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
