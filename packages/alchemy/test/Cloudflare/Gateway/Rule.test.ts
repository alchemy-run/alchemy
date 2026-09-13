import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Account collection (pattern b): Gateway rules live under
// `/accounts/{id}/gateway/rules`. Deploy one rule, then resolve the provider
// with the typed `Provider.findProvider` helper and assert `list()` returns
// the exhaustively-paginated set hydrated into the exact `read` Attributes
// shape (so the deployed rule's id is present).
test.provider("list enumerates the deployed Gateway rule", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const rule = yield* stack.deploy(
      Cloudflare.Gateway.Rule("ListRule", {
        name: "alchemy-zt-rule-list",
        action: "block",
        filters: ["dns"],
        traffic: 'any(dns.domains[*] == "list-test.alchemy-test.example")',
        enabled: true,
      }),
    );

    expect(rule.ruleId).toBeTruthy();
    expect(rule.accountId).toEqual(accountId);

    const provider = yield* Provider.findProvider(Cloudflare.Gateway.Rule);
    const all = yield* provider.list();

    // The deployed rule appears in the exhaustively-paginated result, and the
    // hydrated element matches the `read` Attributes shape exactly.
    const found = all.find((r) => r.ruleId === rule.ruleId);
    expect(found).toBeDefined();
    expect(found?.accountId).toEqual(accountId);
    expect(found?.action).toEqual("block");
    expect(found?.name).toEqual("alchemy-zt-rule-list");

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider(
  "updates a DNS policy schedule and recreates after deletion",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();
      const fixture = (mon: string) =>
        Cloudflare.Gateway.Rule("ScheduledRule", {
          name: "alchemy-zt-rule-schedule",
          action: "block",
          filters: ["dns"],
          traffic:
            'any(dns.domains[*] == "schedule-test.alchemy-test.example")',
          enabled: false,
          schedule: { mon, timeZone: "UTC" },
        });
      const initial = yield* stack.deploy(fixture("09:00-17:00"));
      expect(
        (yield* zeroTrust.getGatewayRule({ accountId, ruleId: initial.ruleId }))
          .schedule?.mon,
      ).toEqual("09:00-17:00");
      const updated = yield* stack.deploy(fixture("10:00-16:00"));
      expect(updated.ruleId).toEqual(initial.ruleId);
      expect(
        (yield* zeroTrust.getGatewayRule({ accountId, ruleId: initial.ruleId }))
          .schedule?.mon,
      ).toEqual("10:00-16:00");
      yield* zeroTrust.deleteGatewayRule({ accountId, ruleId: initial.ruleId });
      const recreated = yield* stack.deploy(fixture("11:00-15:00"));
      expect(recreated.ruleId).not.toEqual(initial.ruleId);
      expect(
        (yield* zeroTrust.getGatewayRule({
          accountId,
          ruleId: recreated.ruleId,
        })).schedule?.mon,
      ).toEqual("11:00-15:00");
      yield* stack.destroy();
    }).pipe(logLevel),
);
