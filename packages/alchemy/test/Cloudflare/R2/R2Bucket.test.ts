import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("list enumerates the deployed R2 bucket", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const bucket = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.R2Bucket("ListResource", {
          name: "alchemy-r2bucket-list-test",
        });
      }),
    );

    const provider = yield* Provider.findProvider(Cloudflare.R2Bucket);
    const all = yield* provider.list();

    const found = all.find((b) => b.bucketName === bucket.bucketName);
    expect(found).toBeDefined();
    expect(found?.accountId).toEqual(bucket.accountId);
    expect(found?.jurisdiction).toEqual(bucket.jurisdiction);
    expect(found?.storageClass).toEqual(bucket.storageClass);

    yield* stack.destroy();
  }).pipe(logLevel),
);
