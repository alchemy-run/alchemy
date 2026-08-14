import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as zones from "@distilled.cloud/cloudflare/zones";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as pathe from "pathe";

/**
 * Regression coverage for zone inference on accounts with more zones than
 * Cloudflare's default `per_page` (20).
 *
 * The Worker provider used to infer a custom domain's zone from a single
 * unpaginated `GET /zones`, so any zone past the first page was invisible and
 * the deploy died with "Could not infer Cloudflare Zone for hostname".
 *
 * Only an account with >20 zones can exercise this, so the file is gated on
 * `CLOUDFLARE_TEST_MANY_ZONES_PROFILE` naming the profile
 * (`~/.alchemy/profiles.json`) for such an account. Unset — as on CI and the
 * standard `testing` run — every test here skips and no credentials resolve.
 */
const PROFILE = process.env.CLOUDFLARE_TEST_MANY_ZONES_PROFILE;

const { test } = Test.make({
  providers: Cloudflare.providers(),
  profile: PROFILE,
});

const main = pathe.resolve(import.meta.dirname, "fixtures/worker.ts");

// Deterministic per-user hostname — never derived from Date.now().
const subdomain = `zone-paging-${process.env.PULL_REQUEST ?? process.env.USER}`;

/**
 * The zone the old code could not see: present in the exhaustive paged
 * listing, absent from the single default-page response. Computed rather than
 * hardcoded so it stays correct as the account's zone set changes. An explicit
 * `CLOUDFLARE_TEST_MANY_ZONES_ZONE_NAME` wins — auto-selection can otherwise
 * land on a production zone.
 */
const zoneBeyondFirstPage = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;

  const all = yield* zones.listZones.pages({ account: { id: accountId } }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).flatMap((page) => page.result ?? []),
    ),
  );

  const override = process.env.CLOUDFLARE_TEST_MANY_ZONES_ZONE_NAME;
  if (override) {
    const named = all.find((zone) => zone.name === override);
    if (!named) {
      return yield* Effect.die(
        new Error(`zone "${override}" not found in account ${accountId}`),
      );
    }
    return { total: all.length, firstPageSize: all.length, zone: named };
  }

  // The exact request the buggy provider made — whatever Cloudflare returns
  // here is the set that inference used to be limited to.
  const firstPage = yield* zones
    .listZones({ account: { id: accountId } })
    .pipe(Effect.map((r) => new Set((r.result ?? []).map((z) => z.id))));

  return {
    total: all.length,
    firstPageSize: firstPage.size,
    // Only an active zone can take a Worker custom domain.
    zone: all.find((z) => !firstPage.has(z.id) && z.status === "active"),
  };
});

const transientRetrySchedule = Schedule.exponential("500 millis");

const findAttachment = (hostname: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    return yield* workers.listDomains({ accountId, hostname }).pipe(
      Effect.map((r) => (r.result ?? []).find((d) => d.hostname === hostname)),
      Effect.retry({
        while: (e) => e._tag === "TooManyRequests",
        schedule: transientRetrySchedule,
        times: 8,
      }),
    );
  });

test.provider.skipIf(!PROFILE)(
  "infers the zone for a hostname past the first page of GET /zones",
  (stack) =>
    Effect.gen(function* () {
      const { total, firstPageSize, zone } = yield* zoneBeyondFirstPage;
      yield* Effect.log(
        `account has ${total} zones, ${firstPageSize} on the first page`,
      );
      if (!zone) {
        // ≤ one page of zones (or none of the overflow is active) — this
        // account cannot reproduce the bug, so there is nothing to assert.
        yield* Effect.log("no active zone past the first page — skipping");
        return;
      }
      yield* Effect.log(`inferring against zone ${zone.name} (${zone.id})`);

      const hostname = `${subdomain}.${zone.name}`;

      yield* stack.destroy();

      yield* Effect.gen(function* () {
        const worker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("ZonePagingWorker", {
              main,
              workersDev: false,
              compatibility: { date: "2024-01-01" },
              domain: hostname,
            });
          }),
        );

        expect(worker.urls).toEqual([`https://${hostname}`]);

        // The assertion that fails pre-fix: inference resolved the hostname
        // to its real zone instead of dying with "Could not infer Cloudflare
        // Zone for hostname".
        const attachment = yield* findAttachment(hostname);
        expect(attachment?.zoneId).toEqual(zone.id);
        expect(attachment?.service).toEqual(worker.workerName);
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)));
    }),
  { timeout: 120_000 },
);
