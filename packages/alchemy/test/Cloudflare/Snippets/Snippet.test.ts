import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Vitest";
import * as snippets from "@distilled.cloud/cloudflare/snippets";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic per-test snippet names (snippet names only allow
// [a-zA-Z0-9_]). Same value on every run — never derived from
// Date.now()/random.
const NAME_EXPLICIT = "alchemy_snippet_explicit_test";
const NAME_REPLACED = "alchemy_snippet_replaced_test";

const codeV1 = `
export default {
  async fetch(request) {
    const response = await fetch(request);
    const newResponse = new Response(response.body, response);
    newResponse.headers.set("x-alchemy-snippet", "v1");
    return newResponse;
  },
};
`;

const codeV2 = codeV1.replace('"v1"', '"v2"');

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

const findSnippet = (zoneId: string, name: string) =>
  snippets.listSnippets({ zoneId, perPage: 100 }).pipe(
    Effect.map((page) => page.result.find((s) => s.snippetName === name)),
    // Freshly-minted scoped tokens propagate eventually-consistently
    // across Cloudflare's edge and intermittently 403. Ride out the
    // blips on the test's own out-of-band verification calls.
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

test.provider(
  "create with generated name, update code in place, destroy",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Snippet("GeneratedSnippet", {
            zoneId,
            code: codeV1,
          }).pipe(adopt(true));
        }),
      );

      // Engine-generated names are normalized to the snippet charset.
      expect(initial.name).toMatch(/^[a-z0-9_]+$/);
      expect(initial.zoneId).toEqual(zoneId);
      expect(initial.mainModule).toEqual("snippet.js");
      expect(initial.createdOn).toBeDefined();

      const live = yield* findSnippet(zoneId, initial.name);
      expect(live?.snippetName).toEqual(initial.name);

      // Update the code — same identity, upserted in place.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Snippet("GeneratedSnippet", {
            zoneId,
            code: codeV2,
          }).pipe(adopt(true));
        }),
      );
      expect(updated.name).toEqual(initial.name);
      expect(updated.createdOn).toEqual(initial.createdOn);

      yield* stack.destroy();

      const gone = yield* findSnippet(zoneId, initial.name);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
);

test.provider("renaming an explicit snippet triggers replacement", (stack) =>
  Effect.gen(function* () {
    const zoneId = yield* resolveZoneId;

    yield* stack.destroy();

    const initial = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Snippet("RenamedSnippet", {
          zoneId,
          name: NAME_EXPLICIT,
          code: codeV1,
        }).pipe(adopt(true));
      }),
    );
    expect(initial.name).toEqual(NAME_EXPLICIT);

    const live = yield* findSnippet(zoneId, NAME_EXPLICIT);
    expect(live?.snippetName).toEqual(NAME_EXPLICIT);

    // The name is the snippet's identity — a rename is a replacement.
    const replaced = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Snippet("RenamedSnippet", {
          zoneId,
          name: NAME_REPLACED,
          code: codeV1,
        }).pipe(adopt(true));
      }),
    );
    expect(replaced.name).toEqual(NAME_REPLACED);

    const newLive = yield* findSnippet(zoneId, NAME_REPLACED);
    expect(newLive?.snippetName).toEqual(NAME_REPLACED);

    // The old snippet was deleted as part of the replacement.
    const oldGone = yield* findSnippet(zoneId, NAME_EXPLICIT);
    expect(oldGone).toBeUndefined();

    yield* stack.destroy();

    const gone = yield* findSnippet(zoneId, NAME_REPLACED);
    expect(gone).toBeUndefined();
  }).pipe(logLevel),
);
