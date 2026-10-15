import * as s3 from "@distilled.cloud/aws/s3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Alchemist from "@/Alchemist/index.ts";
import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: AWS.providers() });

const bucketExists = (bucket: string) =>
  s3.headBucket({ Bucket: bucket }).pipe(
    Effect.as(true),
    Effect.catchTag(["NotFound", "NoSuchBucket"], () => Effect.succeed(false)),
  );

test.provider(
  "a named S3 state store bootstraps, serves state and tears down",
  () =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      // Account-regional names, like the default store's; never the default.
      const name = `alchemy-state-lifecycle-${accountId}-${region}-an`;
      const target = { backend: "aws", name };
      const alchemist = Alchemist.layer();

      yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));

      const created = yield* Alchemist.State.bootstrap(target).pipe(Effect.provide(alchemist));
      expect(created.status).toBe("created");
      expect(yield* bucketExists(name)).toBe(true);
      expect((yield* s3.getBucketVersioning({ Bucket: name })).Status).toBe("Enabled");

      const adopted = yield* Alchemist.State.bootstrap(target).pipe(Effect.provide(alchemist));
      expect(adopted.status).toBe("adopted");

      const store = yield* Alchemist.State.store(target).pipe(Effect.provide(alchemist));
      expect(yield* store.listStacks()).toEqual([]);

      const torn = yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));
      expect(torn.deleted).toEqual([name]);
      expect(yield* bucketExists(name)).toBe(false);

      const again = yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));
      expect(again.deleted).toEqual([]);
    }),
  { timeout: 180_000 },
);
