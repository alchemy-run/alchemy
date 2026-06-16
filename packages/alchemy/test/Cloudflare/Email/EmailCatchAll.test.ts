import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { describe } from "vitest";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

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

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — a fresh token intermittently 403s
// with "Unable to authenticate request". Ride out the blips on the test's
// own out-of-band calls by retrying the typed `Forbidden` error (part of
// each email-routing operation's error union via distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const getCatchAll = (zoneId: string) =>
  emailRouting.getRuleCatchAll({ zoneId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Normalize the zone to a known baseline so each run starts from the same
// cloud state regardless of what a previous (possibly interrupted) run left
// behind: Email Routing enabled, catch-all back at the Cloudflare default
// (disabled, drop, no name).
const setBaseline = (zoneId: string) =>
  emailRouting.enableEmailRouting({ zoneId, body: {} }).pipe(
    Effect.andThen(
      emailRouting.putRuleCatchAll({
        zoneId,
        matchers: [{ type: "all" }],
        actions: [{ type: "drop" }],
        enabled: false,
        name: "",
      }),
    ),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

describe.sequential("EmailCatchAll", () => {
  test.provider(
    "configures the catch-all rule and restores the baseline on destroy",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* setBaseline(zoneId);

        const catchAll = yield* stack.deploy(
          Effect.gen(function* () {
            const routing = yield* Cloudflare.EmailRouting("Routing", {
              zone: zoneName,
            });
            return yield* Cloudflare.EmailCatchAll("CatchAll", {
              zone: { zoneId: routing.zoneId },
              name: "alchemy catch-all",
              actions: [{ type: "drop" }],
            });
          }),
        );

        expect(catchAll.zoneId).toEqual(zoneId);
        expect(catchAll.ruleId).not.toEqual("");
        expect(catchAll.name).toEqual("alchemy catch-all");
        expect(catchAll.enabled).toEqual(true);
        expect(catchAll.actions).toEqual([{ type: "drop" }]);
        // The pre-management state was captured for restore-on-destroy.
        expect(catchAll.initialEnabled).toEqual(false);
        expect(catchAll.initialName).toEqual("");
        expect(catchAll.initialActions).toEqual([{ type: "drop" }]);

        // Out-of-band verification against the live API.
        const live = yield* getCatchAll(zoneId);
        expect(live.enabled).toEqual(true);
        expect(live.name).toEqual("alchemy catch-all");
        expect(live.actions).toEqual([{ type: "drop" }]);

        yield* stack.destroy();

        // Destroy restored the state the catch-all rule had before we
        // managed it. (The rule itself always exists — it is a singleton.)
        const restored = yield* getCatchAll(zoneId);
        expect(restored.enabled).toEqual(false);
        expect(restored.name ?? "").toEqual("");
        expect(restored.actions).toEqual([{ type: "drop" }]);
      }).pipe(logLevel),
  );

  test.provider(
    "updates the catch-all rule in place and keeps the captured baseline",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* setBaseline(zoneId);

        const deployCatchAll = (props: {
          name: string;
          enabled?: boolean;
          actions: Cloudflare.EmailAction[];
        }) =>
          stack.deploy(
            Effect.gen(function* () {
              const routing = yield* Cloudflare.EmailRouting("Routing", {
                zone: zoneName,
              });
              return yield* Cloudflare.EmailCatchAll("CatchAll", {
                zone: { zoneId: routing.zoneId },
                ...props,
              });
            }),
          );

        const initial = yield* deployCatchAll({
          name: "alchemy update test",
          actions: [{ type: "drop" }],
        });

        expect(initial.enabled).toEqual(true);
        expect(initial.initialEnabled).toEqual(false);
        const ruleId = initial.ruleId;

        const updated = yield* deployCatchAll({
          name: "alchemy update test v2",
          enabled: false,
          actions: [{ type: "drop" }],
        });

        // Same singleton updated in place; the captured baseline survives
        // the update so destroy still restores the pre-management state.
        expect(updated.ruleId).toEqual(ruleId);
        expect(updated.zoneId).toEqual(zoneId);
        expect(updated.name).toEqual("alchemy update test v2");
        expect(updated.enabled).toEqual(false);
        expect(updated.initialEnabled).toEqual(false);
        expect(updated.initialName).toEqual("");

        const live = yield* getCatchAll(zoneId);
        expect(live.enabled).toEqual(false);
        expect(live.name).toEqual("alchemy update test v2");

        yield* stack.destroy();

        const restored = yield* getCatchAll(zoneId);
        expect(restored.enabled).toEqual(false);
        expect(restored.name ?? "").toEqual("");
        expect(restored.actions).toEqual([{ type: "drop" }]);
      }).pipe(logLevel),
  );

  // Canonical `list()` test (zone-scoped singleton): there is no account-wide
  // API for this per-zone catch-all rule, so `list()` enumerates every zone
  // via `listAllZones` and reads the singleton in each (skipping zones without
  // Email Routing enabled). Ensure Email Routing is enabled on the standing
  // test zone, then assert the result is non-empty, well-typed, and contains
  // the test zone.
  test.provider(
    "list enumerates the catch-all rule across all zones",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        // Email Routing must be enabled for the test zone's catch-all to be
        // visible to `list()`; normalize to a known baseline.
        yield* setBaseline(zoneId);

        const provider = yield* Provider.findProvider(Cloudflare.EmailCatchAll);
        const all = yield* provider.list();

        expect(all.length).toBeGreaterThan(0);
        const row = all.find((r) => r.zoneId === zoneId);
        expect(row).toBeDefined();
        expect(row!.ruleId).not.toEqual("");
        expect(typeof row!.enabled).toBe("boolean");
        expect(Array.isArray(row!.actions)).toBe(true);

        yield* stack.destroy();
      }).pipe(logLevel),
  );
});
