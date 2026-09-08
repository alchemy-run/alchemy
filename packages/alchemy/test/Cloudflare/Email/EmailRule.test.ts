import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { CatchAllRuleNotSupported } from "@/Cloudflare/Email/Rule.ts";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as emailRouting from "@distilled.cloud/cloudflare/email-routing";
import { describe, expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { emailRoutingScoped } from "./scope.ts";
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
// the email-routing enable operation's error union via distilled patches).
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const rideOutAuth = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden" || e._tag === "Unauthorized",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

// Email Routing must be enabled on the zone for rules to be created and
// visible to `list()`.
const enableRouting = (zoneId: string) =>
  rideOutAuth(emailRouting.enableEmailRouting({ zoneId }));

const getCatchAll = (zoneId: string) =>
  rideOutAuth(emailRouting.getRuleCatchAll({ zoneId }));

const restoreCatchAll = (
  zoneId: string,
  snapshot: emailRouting.GetRuleCatchAllResponse,
) =>
  rideOutAuth(
    emailRouting.putRuleCatchAll({
      zoneId,
      matchers: [{ type: "all" }],
      actions: (snapshot.actions ?? [{ type: "drop" }]).map((a) =>
        a.type === "drop"
          ? { type: "drop" as const }
          : a.type === "forward"
            ? { type: "forward" as const, value: [...(a.value ?? [])] }
            : { type: "worker" as const, value: [...(a.value ?? [])] },
      ),
      enabled: snapshot.enabled ?? false,
      name: snapshot.name ?? "",
    }),
  );

const ADOPT_TO = `adopt-413@${zoneName}`;

const findRuleByTo = (zoneId: string, to: string) =>
  rideOutAuth(
    emailRouting.listRules.items({ zoneId }).pipe(
      Stream.filter(
        (rule) =>
          (rule.matchers ?? []).length === 1 &&
          rule.matchers?.[0]?.type === "literal" &&
          rule.matchers?.[0]?.value === to,
      ),
      Stream.runHead,
      Effect.map(Option.getOrUndefined),
    ),
  );

const purgeRuleByTo = (zoneId: string, to: string) =>
  Effect.gen(function* () {
    const existing = yield* findRuleByTo(zoneId, to);
    if (!existing?.id) return;
    yield* rideOutAuth(
      emailRouting
        .deleteRule({ zoneId, ruleIdentifier: existing.id })
        .pipe(Effect.catchTag("EmailRoutingRuleNotFound", () => Effect.void)),
    );
  });

/**
 * Pull the {@link OwnedBySomeoneElse} value out of a Cause regardless of
 * whether the engine raised it as a typed failure or a defect.
 */
const findOwnedError = (
  cause: Cause.Cause<unknown>,
): OwnedBySomeoneElse | undefined =>
  cause.reasons
    .map((reason) =>
      Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined,
    )
    .find(
      (value): value is OwnedBySomeoneElse =>
        value instanceof OwnedBySomeoneElse,
    );

describe.sequential.skipIf(!emailRoutingScoped)("EmailRule", () => {
  // Canonical `list()` test (zone-scoped collection): email routing rules live
  // under `/zones/{id}/email/routing/rules` with no account-wide enumeration
  // API, so `list()` enumerates every zone via `listAllZones` and exhaustively
  // paginates each zone's rules (skipping zones without Email Routing enabled).
  // Deploy a rule on the standing test zone, then assert it appears in the
  // exhaustively-paginated result.
  test.provider(
    "list enumerates the deployed email rule across all zones",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* enableRouting(zoneId);

        const rule = yield* stack.deploy(
          Effect.gen(function* () {
            const routing = yield* Cloudflare.Email.Routing("Routing", {
              zone: zoneName,
            });
            return yield* Cloudflare.Email.Rule("ListRule", {
              zone: { zoneId: routing.zoneId },
              name: "alchemy list test",
              matchers: [
                {
                  type: "literal",
                  field: "to",
                  value: "list@alchemy-test-2.us",
                },
              ],
              actions: [{ type: "drop" }],
            });
          }),
        );

        expect(rule.zoneId).toEqual(zoneId);
        expect(rule.ruleId).not.toEqual("");

        const provider = yield* Provider.findProvider(Cloudflare.Email.Rule);
        // The freshly-minted scoped token propagates eventually-consistently,
        // so the account-wide enumeration intermittently 401s (`Unauthorized`,
        // code 10000) or 403s (`Forbidden`). Both are transient here — ride
        // out the blip like every other out-of-band call in this suite.
        const all = yield* provider.list().pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden" || e._tag === "Unauthorized",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
        );

        const row = all.find((r) => r.ruleId === rule.ruleId);
        expect(row).toBeDefined();
        expect(row!.zoneId).toEqual(zoneId);
        expect(row!.name).toEqual("alchemy list test");
        expect(Array.isArray(row!.matchers)).toBe(true);
        expect(row!.actions).toEqual([{ type: "drop" }]);

        yield* stack.destroy();
      }).pipe(logLevel),
  );

  // #413: a sole `{ type: "all" }` matcher is the zone catch-all, which
  // already exists once Email Routing is enabled. Creating it as an
  // Email.Rule 409s ("Invalid rule operation"). Fail fast with a typed
  // error pointing at Email.CatchAll, and leave the singleton untouched.
  test.provider(
    "refuses a sole { type: 'all' } matcher and leaves the catch-all untouched (#413)",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* enableRouting(zoneId);

        const before = yield* getCatchAll(zoneId);
        yield* Effect.addFinalizer(() =>
          restoreCatchAll(zoneId, before).pipe(Effect.ignore),
        );

        const error = yield* stack
          .deploy(
            Cloudflare.Email.Rule("CatchAll", {
              zone: zoneName,
              matchers: [{ type: "all" }],
              actions: [{ type: "drop" }],
            }),
          )
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(CatchAllRuleNotSupported);
        expect(String(error)).toContain("Cloudflare.Email.CatchAll");

        const after = yield* getCatchAll(zoneId);
        expect(after.id).toEqual(before.id);
        expect(after.enabled).toEqual(before.enabled);
        expect(after.name ?? "").toEqual(before.name ?? "");
        expect(after.actions).toEqual(before.actions);

        yield* stack.destroy();
      }).pipe(logLevel),
  );

  // A pre-existing non-catch-all rule with identical matchers must be
  // adopted (same physical id) rather than duplicated on first deploy.
  test.provider(
    "adopts a pre-existing non-catch-all rule with identical matchers",
    (stack) =>
      Effect.gen(function* () {
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* enableRouting(zoneId);
        yield* purgeRuleByTo(zoneId, ADOPT_TO);
        yield* Effect.addFinalizer(() =>
          purgeRuleByTo(zoneId, ADOPT_TO).pipe(Effect.ignore),
        );

        const pre = yield* rideOutAuth(
          emailRouting.createRule({
            zoneId,
            name: "alchemy adopt 413",
            matchers: [{ type: "literal", field: "to", value: ADOPT_TO }],
            actions: [{ type: "drop" }],
            enabled: true,
            priority: 0,
          }),
        );
        expect(pre.id).toBeTruthy();

        const error = yield* stack
          .deploy(
            Cloudflare.Email.Rule("AdoptRule", {
              zone: zoneName,
              name: "alchemy adopt 413",
              matchers: [{ type: "literal", field: "to", value: ADOPT_TO }],
              actions: [{ type: "drop" }],
            }),
          )
          .pipe(
            Effect.as(undefined),
            Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
          );
        expect(error).toBeInstanceOf(OwnedBySomeoneElse);

        const adopted = yield* stack.deploy(
          Cloudflare.Email.Rule("AdoptRule", {
            zone: zoneName,
            name: "alchemy adopt 413 v2",
            matchers: [{ type: "literal", field: "to", value: ADOPT_TO }],
            actions: [{ type: "drop" }],
          }).pipe(adopt(true)),
        );
        expect(adopted.ruleId).toEqual(pre.id);
        expect(adopted.name).toEqual("alchemy adopt 413 v2");
        expect(adopted.matchers).toEqual([
          { type: "literal", field: "to", value: ADOPT_TO },
        ]);

        const live = yield* rideOutAuth(
          emailRouting.getRule({
            zoneId,
            ruleIdentifier: adopted.ruleId,
          }),
        );
        expect(live.id).toEqual(pre.id);
        expect(live.name).toEqual("alchemy adopt 413 v2");

        yield* stack.destroy();

        const gone = yield* findRuleByTo(zoneId, ADOPT_TO);
        expect(gone).toBeUndefined();
      }).pipe(logLevel),
    { timeout: 180_000 },
  );
});
