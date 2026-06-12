import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create, verify out-of-band, and destroy tag", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const tag = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.AccessTag("BasicTag", {});
      }),
    );

    expect(tag.name).toBeDefined();
    expect(tag.accountId).toEqual(accountId);

    const actual = yield* zeroTrust.getAccessTag({
      accountId,
      tagName: tag.name,
    });
    expect(actual.name).toEqual(tag.name);

    // Reconcile again with no changes — existence-only resource converges
    // without churn.
    const again = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.AccessTag("BasicTag", {});
      }),
    );
    expect(again.name).toEqual(tag.name);

    yield* stack.destroy();

    const afterDestroy = yield* zeroTrust
      .getAccessTag({ accountId, tagName: tag.name })
      .pipe(
        Effect.catchTag("AccessTagNotFound", () => Effect.succeed(undefined)),
      );
    expect(afterDestroy).toBeUndefined();
  }).pipe(logLevel),
);

test.provider("rename replaces the tag", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const tag = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.AccessTag("RenameTag", {
          name: "alchemy-test-access-tag-a",
        });
      }),
    );
    expect(tag.name).toEqual("alchemy-test-access-tag-a");

    const renamed = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.AccessTag("RenameTag", {
          name: "alchemy-test-access-tag-b",
        });
      }),
    );
    expect(renamed.name).toEqual("alchemy-test-access-tag-b");

    // The new identity exists and the old one is gone (replacement).
    const current = yield* zeroTrust.getAccessTag({
      accountId,
      tagName: "alchemy-test-access-tag-b",
    });
    expect(current.name).toEqual("alchemy-test-access-tag-b");

    const old = yield* zeroTrust
      .getAccessTag({ accountId, tagName: "alchemy-test-access-tag-a" })
      .pipe(
        Effect.catchTag("AccessTagNotFound", () => Effect.succeed(undefined)),
      );
    expect(old).toBeUndefined();

    yield* stack.destroy();

    const afterDestroy = yield* zeroTrust
      .getAccessTag({ accountId, tagName: "alchemy-test-access-tag-b" })
      .pipe(
        Effect.catchTag("AccessTagNotFound", () => Effect.succeed(undefined)),
      );
    expect(afterDestroy).toBeUndefined();
  }).pipe(logLevel),
);
