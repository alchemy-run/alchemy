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

for (const owner of ["Bucket", "StateStore"] as const) {
  describe(`${owner} encryption type blocks`, () => {
    const reconcile = (
      blocked: "SSE-C" | "NONE" | undefined,
      algorithm: "AES256" | "aws:kms",
    ) => {
      const transport = fixture((call) => {
        if (call.query.has("encryption")) {
          return call.method === "GET"
            ? xml(`<ServerSideEncryptionConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
                <Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>${algorithm}</SSEAlgorithm></ApplyServerSideEncryptionByDefault>
                ${blocked === undefined ? "" : `<BlockedEncryptionTypes><EncryptionType>${blocked}</EncryptionType></BlockedEncryptionTypes>`}
                </Rule>
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
                  news: { bucketName, encryption: { sseAlgorithm: "AES256" } },
                  olds: undefined,
                  output,
                  session,
                  bindings: [],
                });
              }),
              transport.environment,
            )
          : Effect.gen(function* () {
              const state = yield* makeS3State({ bucketName });
              yield* state.listStacks();
            }).pipe(Effect.provide(transport.environment));
      return operation.pipe(Effect.as(transport.calls));
    };

    it.effect(
      "retains the observed SSE-C block when default encryption changes",
      () =>
        Effect.gen(function* () {
          const calls = yield* reconcile("SSE-C", "aws:kms");
          const puts = calls.filter(
            (call) => call.method === "PUT" && call.query.has("encryption"),
          );
          expect(puts).toHaveLength(1);
          expect(puts[0]!.body).toContain(
            "<SSEAlgorithm>AES256</SSEAlgorithm>",
          );
          expect(puts[0]!.body).toContain(
            "<BlockedEncryptionTypes><EncryptionType>SSE-C</EncryptionType></BlockedEncryptionTypes>",
          );
        }),
    );

    it.effect("retains an explicit allowance for encryption types", () =>
      Effect.gen(function* () {
        const calls = yield* reconcile("NONE", "aws:kms");
        const puts = calls.filter(
          (call) => call.method === "PUT" && call.query.has("encryption"),
        );
        expect(puts).toHaveLength(1);
        expect(puts[0]!.body).toContain(
          "<BlockedEncryptionTypes><EncryptionType>NONE</EncryptionType></BlockedEncryptionTypes>",
        );
      }),
    );

    it.effect(
      "does not invent encryption blocks when none are configured",
      () =>
        Effect.gen(function* () {
          const calls = yield* reconcile(undefined, "aws:kms");
          const puts = calls.filter(
            (call) => call.method === "PUT" && call.query.has("encryption"),
          );
          expect(puts).toHaveLength(1);
          expect(puts[0]!.body).not.toContain("BlockedEncryptionTypes");
        }),
    );

    it.effect(
      "leaves externally managed blocks untouched when defaults already match",
      () =>
        Effect.gen(function* () {
          const calls = yield* reconcile("SSE-C", "AES256");
          expect(
            calls.filter(
              (call) => call.method === "PUT" && call.query.has("encryption"),
            ),
          ).toEqual([]);
        }),
    );
  });
}
