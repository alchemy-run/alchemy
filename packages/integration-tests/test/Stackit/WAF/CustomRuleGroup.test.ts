import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// Rule groups are free, so this suite is ungated.
const options = { tags: stackitTags("waf", "customrulegroup"), timeout: 300_000 } as const;

const observe = (projectId: string, region: string, name: string) =>
  waf
    .getCustomRuleGroup({ projectId, region, name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

const expectGone = (projectId: string, region: string, name: string) =>
  observe(projectId, region, name).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (group) => group === "gone",
      times: 10,
    }),
    Effect.map((group) => expect(group).toEqual("gone")),
  );

const denyPath = (path: string, description?: string) => ({
  ...(description === undefined ? {} : { description }),
  behavior: { action: "ACTION_DENY" as const },
  conditions: [
    {
      variable: { type: "VARIABLE_REQUEST_URI_RAW" as const },
      operator: { type: "OPERATOR_BEGINS_WITH" as const, value: path },
      transformations: ["TRANSFORMATION_LOWERCASE" as const],
    },
  ],
});

test.provider(
  "create, update and delete a rule group",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stackit.WAF.CustomRuleGroup("Lifecycle", { rules: [denyPath("/admin", "no admin")] }),
      );
      const name = created.ruleGroupName;
      expect(name).toMatch(/^[0-9a-z-]+$/);
      expect(created.rules.length).toEqual(1);
      // STACKIT allocates the id and computes the severity.
      expect(created.rules[0]?.id).toBeGreaterThanOrEqual(1);
      expect(created.rules[0]?.behavior.severity).toEqual(expect.any(String));

      // Out of band: the rule as declared.
      const fetched = yield* waf.getCustomRuleGroup({ projectId, region, name });
      expect(fetched.rules[0]?.description).toEqual("no admin");
      expect(fetched.rules[0]?.behavior.action).toEqual("ACTION_DENY");
      expect(fetched.rules[0]?.conditions[0]?.operator.value).toEqual("/admin");
      expect(fetched.rules[0]?.conditions[0]?.transformations).toEqual([
        "TRANSFORMATION_LOWERCASE",
      ]);

      // Redeploying unchanged is a no-op, despite the computed fields.
      const plan = yield* stack.plan(
        Stackit.WAF.CustomRuleGroup("Lifecycle", { rules: [denyPath("/admin", "no admin")] }),
      );
      expect(plan.resources.Lifecycle).toMatchObject({ action: "noop" });

      // Replace the rules in place: same name, two rules in the declared order.
      const updated = yield* stack.deploy(
        Stackit.WAF.CustomRuleGroup("Lifecycle", {
          rules: [denyPath("/debug"), denyPath("/admin")],
        }),
      );
      expect(updated.ruleGroupName).toEqual(name);
      const refetched = yield* waf.getCustomRuleGroup({ projectId, region, name });
      expect(refetched.rules.map((rule) => rule.conditions[0]?.operator.value)).toEqual([
        "/debug",
        "/admin",
      ]);

      // A removed description is sent as removed, though observed state can't show it.
      expect(refetched.rules[1]?.description ?? "").toEqual("");

      yield* stack.destroy();

      yield* expectGone(projectId, region, name);
    }).pipe(logLevel),
  options,
);

test.provider(
  "a new name replaces create-first and deletes the old group",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const nameA = "alchemy-test-waf-group-a";
      const nameB = "alchemy-test-waf-group-b";
      const group = (name: string) =>
        Stackit.WAF.CustomRuleGroup("Renamed", { name, rules: [denyPath("/admin")] });

      const created = yield* stack.deploy(group(nameA));
      expect(created.ruleGroupName).toEqual(nameA);

      const plan = yield* stack.plan(group(nameB));
      expect(plan.resources.Renamed).toMatchObject({ action: "replace" });

      const renamed = yield* stack.deploy(group(nameB));
      expect(renamed.ruleGroupName).toEqual(nameB);
      yield* expectGone(projectId, region, nameA);

      yield* stack.destroy();

      yield* expectGone(projectId, region, nameB);
    }).pipe(logLevel),
  options,
);

test.provider(
  "recreates a group deleted out of band",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stackit.WAF.CustomRuleGroup("Recreated", { rules: [denyPath("/one")] }),
      );
      const name = created.ruleGroupName;

      yield* waf.deleteCustomRuleGroup({ projectId, region, name });
      yield* expectGone(projectId, region, name);

      const recreated = yield* stack.deploy(
        Stackit.WAF.CustomRuleGroup("Recreated", { rules: [denyPath("/two")] }),
      );
      expect(recreated.ruleGroupName).toEqual(name);
      const fetched = yield* waf.getCustomRuleGroup({ projectId, region, name });
      expect(fetched.rules[0]?.conditions[0]?.operator.value).toEqual("/two");

      yield* stack.destroy();

      yield* expectGone(projectId, region, name);
    }).pipe(logLevel),
  options,
);

test.provider(
  "an explicit name found without state is unowned, and list skips it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const name = "alchemy-test-waf-group-foreign";
      const foreign = Stackit.WAF.CustomRuleGroup("Foreign", { name, rules: [denyPath("/a")] });
      const generated = Stackit.WAF.CustomRuleGroup("Generated", { rules: [denyPath("/b")] });
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          yield* foreign;
          return yield* generated;
        }),
      );

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* foreign;
            yield* generated;
            yield* Stackit.WAF.CustomRuleGroup("Claimant", { name, rules: [denyPath("/c")] });
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      // Nothing was written over it.
      const fetched = yield* waf.getCustomRuleGroup({ projectId, region, name });
      expect(fetched.rules[0]?.conditions[0]?.operator.value).toEqual("/a");

      // `list` under-reports the about 3.6% of generated names with no digit in
      // their tail (see `isGeneratedPhysicalName`); a retry draws a new name.
      const provider = yield* Provider.findProvider(Stackit.WAF.CustomRuleGroup);
      const names = (yield* provider.list()).map((group) => group.ruleGroupName);
      expect(names).toContain(deployed.ruleGroupName);
      expect(names).not.toContain(name);

      yield* stack.destroy();

      yield* expectGone(projectId, region, name);
      yield* expectGone(projectId, region, deployed.ruleGroupName);
    }).pipe(logLevel),
  options,
);
