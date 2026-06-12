import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as rulesets from "@distilled.cloud/cloudflare/rulesets";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// A freshly minted scoped token propagates eventually-consistently across
// Cloudflare's edge — retry the typed `Forbidden` blips on out-of-band calls.
const forbiddenRetrySchedule = Schedule.exponential("500 millis");

const phase = "http_request_firewall_custom";

const resolveAccountId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  return accountId;
});

const getRuleset = (accountId: string, rulesetId: string) =>
  rulesets.getRulesetForAccount({ accountId, rulesetId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
    Effect.catchTag("RulesetNotFound", () => Effect.succeed(undefined)),
  );

// Account-level custom rulesets require an Enterprise plan. On the standard
// testing account every create fails with the typed `PhaseNotEntitled` error
// (code 50002: "not entitled to use the phase http_request_firewall_custom").
// The test probes once: unentitled accounts assert the typed tag; entitled
// accounts run the full lifecycle.
test.provider(
  "custom ruleset lifecycle (typed PhaseNotEntitled on unentitled accounts)",
  (stack) =>
    Effect.gen(function* () {
      const accountId = yield* resolveAccountId;

      yield* stack.destroy();

      const probe = yield* rulesets
        .createRulesetForAccount({
          accountId,
          kind: "custom",
          name: "alchemy-customruleset-probe",
          phase,
          rules: [],
        })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: forbiddenRetrySchedule,
            times: 8,
          }),
          Effect.result,
        );

      if (Result.isFailure(probe)) {
        // Unentitled — the distilled call must fail with the typed
        // entitlement tag, never an untyped catch-all.
        expect(probe.failure._tag).toEqual("PhaseNotEntitled");
        yield* stack.destroy();
        return;
      }

      // Entitled — clean up the probe ruleset and run the full lifecycle.
      yield* rulesets
        .deleteRulesetForAccount({ accountId, rulesetId: probe.success.id })
        .pipe(Effect.catchTag("RulesetNotFound", () => Effect.void));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.CustomRuleset("WafRules", {
            phase,
            description: "alchemy custom ruleset v1",
            rules: [
              {
                description: "Block exploit probes",
                expression: `lower(http.request.uri.path) contains "/.env"`,
                action: "block",
              },
            ],
          });
        }),
      );
      expect(created.accountId).toEqual(accountId);
      expect(created.kind).toEqual("custom");
      expect(created.phase).toEqual(phase);
      expect(created.rules).toHaveLength(1);

      // Out-of-band verification via the distilled API.
      const live = yield* getRuleset(accountId, created.rulesetId);
      expect(live?.description).toEqual("alchemy custom ruleset v1");
      expect(live?.rules?.[0]).toMatchObject({
        action: "block",
        expression: `lower(http.request.uri.path) contains "/.env"`,
      });

      // Update rules + description in place — same physical ruleset.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.CustomRuleset("WafRules", {
            phase,
            description: "alchemy custom ruleset v2",
            rules: [
              {
                description: "Challenge exploit probes",
                expression: `lower(http.request.uri.path) contains "/.env"`,
                action: "managed_challenge",
              },
            ],
          });
        }),
      );
      expect(updated.rulesetId).toEqual(created.rulesetId);
      expect(updated.description).toEqual("alchemy custom ruleset v2");
      expect(updated.rules[0]?.action).toEqual("managed_challenge");

      const patched = yield* getRuleset(accountId, created.rulesetId);
      expect(patched?.rules?.[0]?.action).toEqual("managed_challenge");

      // Destroy and verify the ruleset is gone (typed not-found read).
      yield* stack.destroy();
      const gone = yield* getRuleset(accountId, created.rulesetId);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
