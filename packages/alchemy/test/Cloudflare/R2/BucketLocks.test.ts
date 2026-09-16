import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Cloudflare.providers() });

test.provider(
  "bucket lock rules create, update, omission and explicit removal",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (lockRules?: Cloudflare.R2.BucketLockRule[]) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.R2.Bucket("Locks", { lockRules });
          }),
        );
      const bucket = yield* deploy([
        {
          id: "retention",
          prefix: "audit/",
          condition: { type: "Age", maxAgeSeconds: 3600 },
        },
      ]);
      const get = () =>
        r2.getBucketLock({
          accountId: bucket.accountId,
          bucketName: bucket.bucketName,
        });
      expect((yield* get()).rules).toMatchObject([
        {
          id: "retention",
          enabled: true,
          prefix: "audit/",
          condition: { type: "Age", maxAgeSeconds: 3600 },
        },
      ]);
      yield* deploy([
        {
          id: "retention",
          prefix: "audit/",
          condition: { type: "Indefinite" },
        },
      ]);
      expect((yield* get()).rules?.[0]?.condition).toEqual({
        type: "Indefinite",
      });
      yield* deploy();
      expect((yield* get()).rules?.[0]?.condition).toEqual({
        type: "Indefinite",
      });
      yield* deploy([]);
      expect((yield* get()).rules ?? []).toEqual([]);
      yield* stack.destroy();
      const gone = yield* r2
        .getBucket({
          accountId: bucket.accountId,
          bucketName: bucket.bucketName,
        })
        .pipe(
          Effect.map(() => false),
          Effect.catchTag("NoSuchBucket", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }),
);
