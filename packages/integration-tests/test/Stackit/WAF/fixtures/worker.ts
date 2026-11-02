import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

export const RuleSet = Stackit.WAF.ManagedRuleSet("WafBindingsOwasp", {});

const denyPath = (path: string) => ({
  behavior: { action: "ACTION_DENY" as const },
  conditions: [
    {
      variable: { type: "VARIABLE_REQUEST_URI_RAW" as const },
      operator: { type: "OPERATOR_BEGINS_WITH" as const, value: path },
    },
  ],
});

export const Group = Stackit.WAF.CustomRuleGroup("WafBindingsBlocks", {
  rules: [denyPath("/admin")],
});

export const Firewall = RuleSet.pipe(
  Effect.flatMap((ruleSet) =>
    Stackit.WAF.Configuration("WafBindingsFirewall", {
      managedRuleSetName: ruleSet.ruleSetName,
      labels: { fixture: "waf-bindings" },
    }),
  ),
);

/**
 * A Cloudflare Worker with every WAF binding. One route per binding; each answers
 * `{ ok, result | error }` so a failure surfaces the STACKIT error in the test.
 */
export default class WafBindingsWorker extends Cloudflare.Worker<WafBindingsWorker>()(
  "StackitWafBindingsWorker",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const firewall = yield* Firewall;
    const group = yield* Group;
    const ruleSet = yield* RuleSet;
    const getConfiguration = yield* Stackit.WAF.GetConfiguration(firewall);
    const listConfigurations = yield* Stackit.WAF.ListConfigurations(firewall);
    const updateConfiguration = yield* Stackit.WAF.UpdateConfiguration(firewall);
    const getCustomRuleGroup = yield* Stackit.WAF.GetCustomRuleGroup(group);
    const listCustomRuleGroups = yield* Stackit.WAF.ListCustomRuleGroups(group);
    const updateCustomRuleGroup = yield* Stackit.WAF.UpdateCustomRuleGroup(group);
    const getManagedRuleSet = yield* Stackit.WAF.GetManagedRuleSet(ruleSet);
    const listManagedRuleSets = yield* Stackit.WAF.ListManagedRuleSets(ruleSet);
    const patchManagedRuleSet = yield* Stackit.WAF.PatchManagedRuleSet(ruleSet);
    const getQuota = yield* Stackit.WAF.GetQuota(firewall);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        const param = (name: string) => url.searchParams.get(name) ?? "";
        switch (url.pathname) {
          case "/get-configuration":
            return yield* respond(getConfiguration());
          case "/list-configurations":
            return yield* respond(listConfigurations({ pageSize: "100" }));
          case "/update-configuration":
            return yield* respond(
              updateConfiguration({
                customRuleGroupName: param("group"),
                managedRuleSetName: param("ruleSet"),
              }),
            );
          case "/get-custom-rule-group":
            return yield* respond(getCustomRuleGroup());
          case "/list-custom-rule-groups":
            return yield* respond(listCustomRuleGroups({ pageSize: "100" }));
          case "/update-custom-rule-group":
            return yield* respond(updateCustomRuleGroup({ rules: [denyPath(param("path"))] }));
          case "/get-managed-rule-set":
            return yield* respond(getManagedRuleSet());
          case "/list-managed-rule-sets":
            return yield* respond(listManagedRuleSets({ pageSize: "100" }));
          case "/patch-managed-rule-set":
            return yield* respond(
              patchManagedRuleSet({
                groups: {
                  [param("group")]: { rules: { [param("rule")]: { mode: "MODE_LOG_ONLY" } } },
                },
              }),
            );
          case "/get-quota":
            return yield* respond(getQuota());
          default:
            return HttpServerResponse.text("ok");
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Stackit.WAF.GetConfigurationHttp,
        Stackit.WAF.ListConfigurationsHttp,
        Stackit.WAF.UpdateConfigurationHttp,
        Stackit.WAF.GetCustomRuleGroupHttp,
        Stackit.WAF.ListCustomRuleGroupsHttp,
        Stackit.WAF.UpdateCustomRuleGroupHttp,
        Stackit.WAF.GetManagedRuleSetHttp,
        Stackit.WAF.ListManagedRuleSetsHttp,
        Stackit.WAF.PatchManagedRuleSetHttp,
        Stackit.WAF.GetQuotaHttp,
      ),
    ),
  ),
) {}
