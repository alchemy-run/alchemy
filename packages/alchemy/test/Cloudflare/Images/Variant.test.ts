import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as images from "@distilled.cloud/cloudflare/images";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Out-of-band read of a variant, riding out eventual-consistency blips
// where the freshly created variant is not yet visible (`VariantNotFound`,
// Cloudflare error code 5401).
const getVariant = (accountId: string, variantId: string) =>
  images.getV1Variant({ accountId, variantId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "VariantNotFound",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

// Poll until the variant is gone — a missing variant surfaces as the typed
// `VariantNotFound`, which is the success condition here.
const expectGone = (accountId: string, variantId: string) =>
  images.getV1Variant({ accountId, variantId }).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "VariantNotDeleted" } as const)),
    Effect.catchTag("VariantNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "VariantNotDeleted",
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );

test.provider("create, update in place, and delete a variant", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    // Variant names are alphanumeric only (no hyphens/underscores) — use
    // the logical ID verbatim as the deterministic name.
    const created = yield* stack.deploy(
      Cloudflare.ImagesVariant("alchemytestvariant", {
        fit: "cover",
        width: 100,
        height: 100,
      }),
    );

    expect(created.variantName).toEqual("alchemytestvariant");
    expect(created.accountId).toEqual(accountId);
    expect(created.fit).toEqual("cover");
    expect(created.width).toEqual(100);
    expect(created.height).toEqual(100);
    expect(created.metadata).toEqual("none");
    expect(created.neverRequireSignedURLs).toEqual(false);

    // Out-of-band verification against the live API.
    const live = yield* getVariant(accountId, created.variantName);
    expect(live.variant?.id).toEqual("alchemytestvariant");
    expect(live.variant?.options.fit).toEqual("cover");
    expect(live.variant?.options.width).toEqual(100);
    expect(live.variant?.options.height).toEqual(100);

    // Update mutable options in place — same variant name, PATCHed options.
    const updated = yield* stack.deploy(
      Cloudflare.ImagesVariant("alchemytestvariant", {
        fit: "contain",
        width: 200,
        height: 100,
        metadata: "copyright",
        neverRequireSignedURLs: true,
      }),
    );

    expect(updated.variantName).toEqual("alchemytestvariant");
    expect(updated.fit).toEqual("contain");
    expect(updated.width).toEqual(200);
    expect(updated.height).toEqual(100);
    expect(updated.metadata).toEqual("copyright");
    expect(updated.neverRequireSignedURLs).toEqual(true);

    const patched = yield* getVariant(accountId, updated.variantName);
    expect(patched.variant?.options.fit).toEqual("contain");
    expect(patched.variant?.options.width).toEqual(200);
    expect(patched.variant?.options.metadata).toEqual("copyright");
    expect(patched.variant?.neverRequireSignedURLs).toEqual(true);

    // No-op redeploy — identical props, still the same variant.
    const noop = yield* stack.deploy(
      Cloudflare.ImagesVariant("alchemytestvariant", {
        fit: "contain",
        width: 200,
        height: 100,
        metadata: "copyright",
        neverRequireSignedURLs: true,
      }),
    );
    expect(noop.variantName).toEqual("alchemytestvariant");

    yield* stack.destroy();

    yield* expectGone(accountId, "alchemytestvariant");

    // Destroy again — delete is idempotent.
    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("replace a variant when the name changes", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Cloudflare.ImagesVariant("ReplaceVariant", {
        name: "alchemyreplacea",
        fit: "cover",
        width: 64,
        height: 64,
      }),
    );
    expect(initial.variantName).toEqual("alchemyreplacea");

    // Renaming the variant replaces it — the name is the API path id.
    const replaced = yield* stack.deploy(
      Cloudflare.ImagesVariant("ReplaceVariant", {
        name: "alchemyreplaceb",
        fit: "cover",
        width: 64,
        height: 64,
      }),
    );
    expect(replaced.variantName).toEqual("alchemyreplaceb");

    const live = yield* getVariant(accountId, "alchemyreplaceb");
    expect(live.variant?.id).toEqual("alchemyreplaceb");

    // The old variant is gone after the replacement completes.
    yield* expectGone(accountId, "alchemyreplacea");

    yield* stack.destroy();
    yield* expectGone(accountId, "alchemyreplaceb");
  }).pipe(logLevel),
);
