import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Vitest";
import * as ddos from "@distilled.cloud/cloudflare/ddos-protection";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Advanced TCP Protection is a Magic Transit (Enterprise add-on)
// entitlement that the testing account does not have — every API call fails
// with the typed `AdvancedTcpProtectionNotEntitled` error (Cloudflare code
// 8888; asserted in AllowlistEntry.test.ts). The lifecycle suite is gated
// behind an opt-in env var for entitled accounts.
const magicTransit = process.env.CLOUDFLARE_TEST_MAGIC_TRANSIT;

const accountId = Effect.gen(function* () {
  const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
  return accountId;
});

test.provider.skipIf(!magicTransit)(
  "creates a global TCP flow protection rule, updates it in place, and destroys",
  (stack) =>
    Effect.gen(function* () {
      const acct = yield* accountId;

      yield* stack.destroy();

      // Create.
      const rule = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.TcpFlowProtectionRule("Rule", {
            scope: "global",
            mode: "monitoring",
            burstSensitivity: "medium",
            rateSensitivity: "medium",
          });
        }),
      );
      expect(rule.scope).toEqual("global");
      expect(rule.name).toEqual("global");
      expect(rule.mode).toEqual("monitoring");

      // Out-of-band verification via the distilled API.
      const live =
        yield* ddos.getAdvancedTcpProtectionTcpFlowProtectionRuleItem({
          accountId: acct,
          ruleId: rule.ruleId,
        });
      expect(live.mode).toEqual("monitoring");
      expect(live.rateSensitivity).toEqual("medium");

      // In-place update — mode and sensitivities are patched, id is stable.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.TcpFlowProtectionRule("Rule", {
            scope: "global",
            mode: "disabled",
            burstSensitivity: "low",
            rateSensitivity: "high",
          });
        }),
      );
      expect(updated.ruleId).toEqual(rule.ruleId);
      expect(updated.mode).toEqual("disabled");
      expect(updated.burstSensitivity).toEqual("low");
      expect(updated.rateSensitivity).toEqual("high");

      yield* stack.destroy();

      // Gone — the typed TcpFlowProtectionRuleNotFound error proves deletion.
      const error = yield* ddos
        .getAdvancedTcpProtectionTcpFlowProtectionRuleItem({
          accountId: acct,
          ruleId: rule.ruleId,
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("TcpFlowProtectionRuleNotFound");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
