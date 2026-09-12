import type { BucketEncryption } from "@/AWS/S3/Bucket.ts";
import { makeS3State } from "@/AWS/StateStore/State.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  bucketName,
  bucketProvider,
  existingStateBucket,
  fixture,
  instanceId,
  output,
  provideBucket,
  session,
  xml,
} from "./fixtures/bucket-provider.ts";

const keyArn =
  "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-1111-1111-111111111111";
const otherKeyArn =
  "arn:aws:kms:us-east-1:123456789012:key/22222222-2222-2222-2222-222222222222";

for (const owner of ["Bucket", "StateStore"] as const) {
  describe(`${owner} encryption key identity`, () => {
    const reconcile = (desired: BucketEncryption) => {
      const transport = fixture((call) => {
        if (call.query.has("encryption")) {
          return call.method === "GET"
            ? xml(`<ServerSideEncryptionConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
                <Rule><ApplyServerSideEncryptionByDefault>
                  <SSEAlgorithm>aws:kms</SSEAlgorithm>
                  <KMSMasterKeyID>${keyArn}</KMSMasterKeyID>
                </ApplyServerSideEncryptionByDefault><BucketKeyEnabled>false</BucketKeyEnabled></Rule>
              </ServerSideEncryptionConfiguration>`)
            : xml("");
        }
        return existingStateBucket(call);
      });
      const operation =
        owner === "Bucket"
          ? provideBucket(
              Effect.gen(function* () {
                const provider = yield* bucketProvider;
                yield* provider.reconcile({
                  id: "Bucket",
                  fqn: "Bucket",
                  instanceId,
                  news: { bucketName, encryption: desired },
                  olds: undefined,
                  output,
                  session,
                  bindings: [],
                });
              }),
              transport.environment,
            )
          : Effect.gen(function* () {
              const state = yield* makeS3State({
                bucketName,
                encryption: desired,
              });
              yield* state.listStacks();
            }).pipe(Effect.provide(transport.environment));
      return operation.pipe(Effect.as(transport.calls));
    };

    it.effect("does not rewrite an unchanged decoded KMS key", () =>
      Effect.gen(function* () {
        const calls = yield* reconcile({
          sseAlgorithm: "aws:kms",
          kmsMasterKeyId: keyArn,
        });
        expect(
          calls.filter(
            (call) => call.method === "PUT" && call.query.has("encryption"),
          ),
        ).toEqual([]);
      }),
    );

    it.effect(
      "writes a different key instead of equating redacted values",
      () =>
        Effect.gen(function* () {
          const calls = yield* reconcile({
            sseAlgorithm: "aws:kms",
            kmsMasterKeyId: otherKeyArn,
          });
          const puts = calls.filter(
            (call) => call.method === "PUT" && call.query.has("encryption"),
          );
          expect(puts).toHaveLength(1);
          expect(puts[0]!.body).toContain(
            `<KMSMasterKeyID>${otherKeyArn}</KMSMasterKeyID>`,
          );
        }),
    );

    it.effect("still reconciles bucket key settings for the same KMS key", () =>
      Effect.gen(function* () {
        const calls = yield* reconcile({
          sseAlgorithm: "aws:kms",
          kmsMasterKeyId: keyArn,
          bucketKeyEnabled: true,
        });
        const puts = calls.filter(
          (call) => call.method === "PUT" && call.query.has("encryption"),
        );
        expect(puts).toHaveLength(1);
        expect(puts[0]!.body).toContain(
          "<BucketKeyEnabled>true</BucketKeyEnabled>",
        );
      }),
    );
  });
}
