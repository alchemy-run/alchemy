import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Vitest";
import * as rum from "@distilled.cloud/cloudflare/rum";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Use a different zone than Site.test.ts — both suites manage zone-scoped
// Web Analytics sites, and Cloudflare keys those to the zone, so running
// the two files in parallel against the same zone would interfere.
const zoneName = "alchemy-test-3.us";

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, declared in the distilled error union) on the test's
// own out-of-band verification calls.
const listRules = (accountId: string, rulesetId: string) =>
  rum.listRules({ accountId, rulesetId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const findRule = (accountId: string, rulesetId: string, ruleId: string) =>
  listRules(accountId, rulesetId).pipe(
    Effect.map((response) =>
      (response.rules ?? []).find((rule) => rule.id === ruleId),
    ),
  );

// A deleted rule disappears from the ruleset's rule list; once the parent
// site is destroyed the whole ruleset is gone (`RulesetNotFound`). Both are
// the success condition here.
const expectGone = (accountId: string, rulesetId: string, ruleId: string) =>
  findRule(accountId, rulesetId, ruleId).pipe(
    Effect.flatMap((rule) =>
      rule === undefined
        ? Effect.void
        : Effect.fail({ _tag: "RuleNotDeleted" } as const),
    ),
    Effect.catchTag("RulesetNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "RuleNotDeleted",
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );

// The free plan caps Web Analytics rule creation at a tiny account-wide
// quota (`MaxRulesExceeded`, HTTP 409 / code 10012
// `web_analytics.configuration.api.maxRulesError`). Empirically the cap
// behaves like a rolling created-rules counter: deleting rules does not
// promptly free it, so repeated test runs can exhaust it for a while even
// when zero rules exist on the account. Ride out short contention with a
// bounded retry on the typed tag, then surface `undefined` so the test can
// skip gracefully instead of failing on a platform quota.
const retryingQuota = <A, R>(deploy: Effect.Effect<A, any, R>) =>
  deploy.pipe(
    Effect.retry({
      while: (e) => e._tag === "MaxRulesExceeded",
      schedule: Schedule.spaced("6 seconds"),
      times: 5,
    }),
    Effect.catchTag("MaxRulesExceeded", () => Effect.succeed(undefined)),
  );

const quotaExhausted = (stack: { destroy: () => Effect.Effect<void, any> }) =>
  Effect.gen(function* () {
    yield* Effect.logWarning(
      "skipping RumRule assertions: account-wide Web Analytics rule quota " +
        "is exhausted (MaxRulesExceeded, code 10012, " +
        "web_analytics.configuration.api.maxRulesError)",
    );
    yield* stack.destroy();
  });

// A failed earlier run can leak a zone-based site measuring the test zone;
// the Site provider's cold read would then surface it as `Unowned` and
// refuse the deploy. Clean any leftovers out-of-band before deploying.
const cleanupLeftoverSites = (accountId: string, zoneTag: string) =>
  Effect.gen(function* () {
    const sites = yield* rum.listSiteInfos({ accountId, perPage: 100 }).pipe(
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: Schedule.exponential("500 millis"),
        times: 8,
      }),
    );
    for (const site of sites.result ?? []) {
      if (site.ruleset?.zoneTag === zoneTag && site.siteTag) {
        yield* rum
          .deleteSiteInfo({ accountId, siteId: site.siteTag })
          .pipe(Effect.catchTag("SiteNotFound", () => Effect.void));
      }
    }
  });

// One program deploying the zone-based site (which owns the implicit
// ruleset) and the rule under it. The rule's `rulesetId` references the
// site's output, so the engine orders rule-last on deploy (and first on
// destroy).
const program = (
  zoneId: string,
  rule: Omit<Cloudflare.RumRuleProps, "rulesetId">,
) =>
  Effect.gen(function* () {
    const site = yield* Cloudflare.RumSite("RuleSite", {
      zoneTag: zoneId,
    });
    const ruleResource = yield* Cloudflare.RumRule("Rule", {
      rulesetId: site.rulesetId.as<string>(),
      ...rule,
    });
    return { site, rule: ruleResource };
  });

test.provider("create, update in place, and delete a rule", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const zone = yield* findZoneByName({ accountId, name: zoneName });
    if (!zone) {
      return yield* Effect.die(
        new Error(`zone "${zoneName}" not found in account`),
      );
    }

    yield* stack.destroy();
    yield* cleanupLeftoverSites(accountId, zone.id);

    const initial = yield* retryingQuota(
      stack.deploy(
        program(zone.id, {
          host: zoneName,
          paths: ["/blog/*"],
          inclusive: false,
        }),
      ),
    );
    if (initial === undefined) return yield* quotaExhausted(stack);

    expect(initial.site.rulesetId).toBeTruthy();
    expect(initial.rule.id).toBeTruthy();
    expect(initial.rule.rulesetId).toEqual(initial.site.rulesetId);
    expect(initial.rule.accountId).toEqual(accountId);
    expect(initial.rule.host).toEqual(zoneName);
    expect(initial.rule.paths).toEqual(["/blog/*"]);
    expect(initial.rule.inclusive).toEqual(false);
    expect(initial.rule.isPaused).toEqual(false);

    // Verify out-of-band against the live API.
    const live = yield* findRule(
      accountId,
      initial.rule.rulesetId,
      initial.rule.id,
    );
    expect(live).toBeDefined();
    expect(live?.host).toEqual(zoneName);
    expect(live?.paths).toEqual(["/blog/*"]);
    expect(live?.inclusive).toEqual(false);

    // Update paths and pause the rule in place — same rule id.
    const updated = yield* stack.deploy(
      program(zone.id, {
        host: zoneName,
        paths: ["/blog/*", "/admin/*"],
        inclusive: false,
        isPaused: true,
      }),
    );
    expect(updated.rule.id).toEqual(initial.rule.id);
    expect(updated.rule.paths).toEqual(["/blog/*", "/admin/*"]);
    expect(updated.rule.isPaused).toEqual(true);

    const liveUpdated = yield* findRule(
      accountId,
      updated.rule.rulesetId,
      updated.rule.id,
    );
    expect(liveUpdated?.paths).toEqual(["/blog/*", "/admin/*"]);
    expect(liveUpdated?.isPaused).toEqual(true);

    // Redeploying identical props is a no-op (still the same rule).
    const noop = yield* stack.deploy(
      program(zone.id, {
        host: zoneName,
        paths: ["/blog/*", "/admin/*"],
        inclusive: false,
        isPaused: true,
      }),
    );
    expect(noop.rule.id).toEqual(initial.rule.id);

    const rulesetId = initial.rule.rulesetId;
    yield* stack.destroy();

    yield* expectGone(accountId, rulesetId, initial.rule.id);
  }).pipe(logLevel),
);

test.provider("recreates after out-of-band delete", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const zone = yield* findZoneByName({ accountId, name: zoneName });
    if (!zone) {
      return yield* Effect.die(
        new Error(`zone "${zoneName}" not found in account`),
      );
    }

    yield* stack.destroy();
    yield* cleanupLeftoverSites(accountId, zone.id);

    const initial = yield* retryingQuota(
      stack.deploy(
        program(zone.id, {
          host: zoneName,
          paths: ["/heal/*"],
          inclusive: false,
        }),
      ),
    );
    if (initial === undefined) return yield* quotaExhausted(stack);

    // Delete the rule out-of-band. A redeploy with identical props is a
    // planner no-op, so change a prop to force reconcile — it must observe
    // the rule as missing and recreate it instead of failing.
    yield* rum
      .deleteRule({
        accountId,
        rulesetId: initial.rule.rulesetId,
        ruleId: initial.rule.id,
      })
      .pipe(
        Effect.retry({
          while: (e) => e._tag === "Forbidden",
          schedule: Schedule.exponential("500 millis"),
          times: 8,
        }),
      );

    const healed = yield* retryingQuota(
      stack.deploy(
        program(zone.id, {
          host: zoneName,
          paths: ["/heal-v2/*"],
          inclusive: false,
        }),
      ),
    );
    if (healed === undefined) return yield* quotaExhausted(stack);

    expect(healed.rule.id).not.toEqual(initial.rule.id);
    expect(healed.rule.paths).toEqual(["/heal-v2/*"]);

    const live = yield* findRule(
      accountId,
      healed.rule.rulesetId,
      healed.rule.id,
    );
    expect(live?.paths).toEqual(["/heal-v2/*"]);

    const rulesetId = healed.rule.rulesetId;
    yield* stack.destroy();

    yield* expectGone(accountId, rulesetId, healed.rule.id);
  }).pipe(logLevel),
);
