import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import {
  inferZoneIdForHostname,
  isId,
  resolveZoneId,
  type ZoneCache,
  zoneNameCandidates,
} from "@/Cloudflare/Zone/lookup.ts";
import {
  apiTokenCredentials,
  Credentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { describe, expect, test } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

describe("Cloudflare zone lookup", () => {
  const withoutCredentials = <A, E>(effect: Effect.Effect<A, E, Credentials>) =>
    effect.pipe(
      Effect.provideService(
        Credentials,
        Effect.die("explicit zone IDs must not resolve credentials"),
      ),
      Effect.runSync,
    );

  test("zoneNameCandidates walks hostname labels longest-first", () => {
    expect(zoneNameCandidates("app.example.com")).toEqual([
      "app.example.com",
      "example.com",
    ]);
    expect(zoneNameCandidates("a.b.c.example.com")).toEqual([
      "a.b.c.example.com",
      "b.c.example.com",
      "c.example.com",
      "example.com",
    ]);
    expect(zoneNameCandidates("example.com")).toEqual(["example.com"]);
  });

  test("resolveZoneId returns an explicit zone id without listing zones", () => {
    const zoneId = "0123456789abcdef0123456789abcdef";
    expect(isId(zoneId)).toBe(true);
    expect(
      withoutCredentials(
        resolveZoneId({
          accountId: "account",
          zone: zoneId,
          hostname: "app.example.com",
        }),
      ),
    ).toEqual(zoneId);
    expect(
      withoutCredentials(
        resolveZoneId({
          accountId: "account",
          zone: { zoneId, name: "example.com" },
          hostname: "app.example.com",
        }),
      ),
    ).toEqual(zoneId);
  });
});

// The Worker provider used to infer a zone by calling `listZones({})` and
// matching the hostname against the page that came back. That endpoint
// paginates at 20 zones per page, so a Worker domain or route on the 21st
// zone of an account resolved to nothing. Inference now goes through
// `resolveZoneId`, which walks the hostname's label hierarchy with exact
// `?name=` lookups — making the account's zone count irrelevant.
describe("inferZoneIdForHostname", () => {
  const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
  const API_BASE_URL = "https://api.cloudflare.test/client/v4";

  const TestContext = Layer.mergeAll(
    Layer.succeed(
      Credentials,
      Effect.succeed(
        apiTokenCredentials({
          apiToken: "test-token",
          apiBaseUrl: API_BASE_URL,
        }),
      ),
    ),
    Layer.succeed(
      CloudflareEnvironment,
      Effect.succeed({
        type: "apiToken" as const,
        apiToken: Redacted.make("test-token"),
        accountId: ACCOUNT_ID,
        source: { type: "env" as const },
      }),
    ),
  );

  /**
   * Stands in for `GET /zones?account.id=…&name=…&per_page=1` — the only
   * request `findZoneByName` makes — and records the `name` of every lookup
   * so a test can assert the hierarchy walk. A request without a `name=`
   * filter (i.e. a plain zone listing) throws: that is the bug this suite
   * guards, and no amount of stubbed zones can paper over it.
   */
  const stubZonesApi = (
    zonesOnAccount: { id: string; name: string }[],
    delayMs = 0,
  ) => {
    const original = globalThis.fetch;
    const queried: string[] = [];
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      const name = url.searchParams.get("name");
      if (!name) {
        throw new Error(
          `zone inference issued an unfiltered listing: ${url.toString()}`,
        );
      }
      queried.push(name);
      const match =
        url.searchParams.get("account.id") === ACCOUNT_ID
          ? zonesOnAccount.find((zone) => zone.name === name)
          : undefined;
      const response = () =>
        new Response(
          JSON.stringify({
            success: true,
            result: match ? [{ ...match, account: { id: ACCOUNT_ID } }] : [],
          }),
          { headers: { "content-type": "application/json" } },
        );
      return new Promise<Response>((resolve) =>
        setTimeout(() => resolve(response()), delayMs),
      );
    }) as typeof globalThis.fetch;
    return {
      queried,
      restore: () => {
        globalThis.fetch = original;
      },
    };
  };

  const withStubbedZonesApi = <A, E>(
    zonesOnAccount: { id: string; name: string }[],
    body: (stub: {
      queried: string[];
    }) => Effect.Effect<A, E, Credentials | CloudflareEnvironment>,
    delayMs = 0,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => stubZonesApi(zonesOnAccount, delayMs)),
      body,
      (stub) => Effect.sync(stub.restore),
    ).pipe(Effect.provide(TestContext));

  const zoneId = (label: string) => label.padEnd(32, "0");

  test.live(
    "resolves a zone that a listing would have paginated away",
    () =>
      withStubbedZonesApi(
        // The target zone sits behind 20 others — page 2 of a listing.
        [
          ...Array.from({ length: 20 }, (_, index) => ({
            id: zoneId(`filler${index}`),
            name: `filler-${index}.com`,
          })),
          { id: zoneId("target"), name: "target.com" },
        ],
        (stub) =>
          Effect.gen(function* () {
            const resolved = yield* inferZoneIdForHostname(
              "app.target.com",
              new Map(),
            );
            expect(resolved).toBe(zoneId("target"));
            expect(stub.queried).toEqual(["app.target.com", "target.com"]);
          }),
      ),
    { exclusive: true },
  );

  test.live(
    "walks the label hierarchy up to the registrable domain",
    () =>
      withStubbedZonesApi(
        [{ id: zoneId("example"), name: "example.com" }],
        (stub) =>
          Effect.gen(function* () {
            const resolved = yield* inferZoneIdForHostname(
              "api.staging.example.com",
              new Map(),
            );
            expect(resolved).toBe(zoneId("example"));
            expect(stub.queried).toEqual([
              "api.staging.example.com",
              "staging.example.com",
              "example.com",
            ]);
          }),
      ),
    { exclusive: true },
  );

  test.live(
    "stops at the first hit when a subdomain is itself a zone",
    () =>
      withStubbedZonesApi(
        [
          { id: zoneId("staging"), name: "staging.example.com" },
          { id: zoneId("example"), name: "example.com" },
        ],
        (stub) =>
          Effect.gen(function* () {
            const resolved = yield* inferZoneIdForHostname(
              "api.staging.example.com",
              new Map(),
            );
            expect(resolved).toBe(zoneId("staging"));
            expect(stub.queried).toEqual([
              "api.staging.example.com",
              "staging.example.com",
            ]);
          }),
      ),
    { exclusive: true },
  );

  test.live(
    "serves a repeat lookup from the per-run cache",
    () =>
      withStubbedZonesApi(
        [{ id: zoneId("example"), name: "example.com" }],
        (stub) =>
          Effect.gen(function* () {
            const zoneCache: ZoneCache = new Map();
            const first = yield* inferZoneIdForHostname(
              "app.example.com",
              zoneCache,
            );
            const afterFirst = [...stub.queried];
            const second = yield* inferZoneIdForHostname(
              "app.example.com",
              zoneCache,
            );
            expect(second).toBe(first);
            expect(stub.queried).toEqual(afterFirst);
          }),
      ),
    { exclusive: true },
  );

  test.live(
    "collapses concurrent lookups of the same hostname into one",
    () =>
      withStubbedZonesApi(
        [{ id: zoneId("example"), name: "example.com" }],
        (stub) =>
          Effect.gen(function* () {
            const zoneCache: ZoneCache = new Map();
            const resolved = yield* Effect.all(
              Array.from({ length: 8 }, () =>
                inferZoneIdForHostname("app.example.com", zoneCache),
              ),
              { concurrency: "unbounded" },
            );
            expect(resolved).toEqual(Array(8).fill(zoneId("example")));
            // The map holds the lookup *effect*, installed inside
            // `Effect.suspend` with no yield point between get and set, so
            // eight fibers share one in-flight walk rather than each
            // starting their own.
            expect(stub.queried).toEqual(["app.example.com", "example.com"]);
          }),
        // Real latency on every request, so the fibers genuinely overlap.
        10,
      ),
    { exclusive: true },
  );

  test.live(
    "dies once the hierarchy is exhausted without a match",
    () =>
      withStubbedZonesApi(
        [{ id: zoneId("other"), name: "other.com" }],
        (stub) =>
          Effect.gen(function* () {
            const exit = yield* Effect.exit(
              inferZoneIdForHostname("api.example.com", new Map()),
            );
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              // A defect rather than a typed failure: an unresolvable zone
              // is a misconfiguration the engine cannot converge past.
              expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(true);
            }
            expect(stub.queried).toEqual(["api.example.com", "example.com"]);
          }),
      ),
    { exclusive: true },
  );
});
