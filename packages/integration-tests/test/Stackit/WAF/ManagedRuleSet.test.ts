import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// Rule sets are free, so this suite is ungated.
const options = { tags: stackitTags("waf", "managedruleset"), timeout: 300_000 } as const;

const observe = (projectId: string, region: string, name: string) =>
  waf
    .getManagedRuleSet({ projectId, region, name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

const expectGone = (projectId: string, region: string, name: string) =>
  observe(projectId, region, name).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (ruleSet) => ruleSet === "gone",
      times: 10,
    }),
    Effect.map((ruleSet) => expect(ruleSet).toEqual("gone")),
  );

/** A rule id of the inventory and a mode that differs from its current one. */
const firstRule = (groups: waf.GetManagedRuleSetResponseGroupsMap | undefined) => {
  const [groupId, group] = Object.entries(groups ?? {})[0]!;
  const [ruleId, rule] = Object.entries(group!.rules ?? {})[0]!;
  const mode = rule!.mode;
  const other: waf.Mode = mode === "MODE_LOG_ONLY" ? "MODE_DISABLED" : "MODE_LOG_ONLY";
  return { groupId, ruleId, mode, other };
};

test.provider(
  "create, tune and delete a rule set",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(Stackit.WAF.ManagedRuleSet("Lifecycle", {}));
      const name = created.ruleSetName;
      expect(name).toMatch(/^[0-9a-z-]+$/);
      expect(created.type).toEqual("TYPE_OWASP_CRS");
      expect(created.version).toEqual(expect.any(String));
      expect(Object.keys(created.groups ?? {}).length).toBeGreaterThan(0);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.WAF.ManagedRuleSet("Lifecycle", {}));
      expect(plan.resources.Lifecycle).toMatchObject({ action: "noop" });

      // Set one rule's mode in place, verified out of band.
      const { groupId, ruleId, mode, other } = firstRule(created.groups);
      const groups = { [groupId]: { rules: { [ruleId]: { mode: other } } } };
      const tuned = yield* stack.deploy(Stackit.WAF.ManagedRuleSet("Lifecycle", { groups }));
      expect(tuned.ruleSetName).toEqual(name);
      expect(tuned.originalModes[groupId]?.[ruleId]).toEqual(mode);
      const fetched = yield* waf.getManagedRuleSet({ projectId, region, name });
      expect(fetched.groups?.[groupId]?.rules?.[ruleId]?.mode).toEqual(other);

      const replan = yield* stack.plan(Stackit.WAF.ManagedRuleSet("Lifecycle", { groups }));
      expect(replan.resources.Lifecycle).toMatchObject({ action: "noop" });

      // Removing the override restores the mode it had.
      yield* stack.deploy(Stackit.WAF.ManagedRuleSet("Lifecycle", {}));
      const restored = yield* waf.getManagedRuleSet({ projectId, region, name });
      expect(restored.groups?.[groupId]?.rules?.[ruleId]?.mode).toEqual(mode);

      yield* stack.destroy();

      yield* expectGone(projectId, region, name);
    }).pipe(logLevel),
  options,
);

test.provider(
  "a new name replaces create-first and deletes the old rule set",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const nameA = "alchemy-test-waf-rules-a";
      const nameB = "alchemy-test-waf-rules-b";
      const created = yield* stack.deploy(Stackit.WAF.ManagedRuleSet("Renamed", { name: nameA }));
      expect(created.ruleSetName).toEqual(nameA);

      const plan = yield* stack.plan(Stackit.WAF.ManagedRuleSet("Renamed", { name: nameB }));
      expect(plan.resources.Renamed).toMatchObject({ action: "replace" });

      const renamed = yield* stack.deploy(Stackit.WAF.ManagedRuleSet("Renamed", { name: nameB }));
      expect(renamed.ruleSetName).toEqual(nameB);
      yield* expectGone(projectId, region, nameA);

      yield* stack.destroy();

      yield* expectGone(projectId, region, nameB);
    }).pipe(logLevel),
  options,
);

test.provider(
  "an explicit name found without state is unowned, and list skips it",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const name = "alchemy-test-waf-rules-foreign";
      const foreign = Stackit.WAF.ManagedRuleSet("Foreign", { name });
      const generated = Stackit.WAF.ManagedRuleSet("Generated", {});
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
            yield* Stackit.WAF.ManagedRuleSet("Claimant", { name });
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      // `list` under-reports the about 3.6% of generated names with no digit in
      // their tail (see `isGeneratedPhysicalName`); a retry draws a new name.
      const provider = yield* Provider.findProvider(Stackit.WAF.ManagedRuleSet);
      const names = (yield* provider.list()).map((ruleSet) => ruleSet.ruleSetName);
      expect(names).toContain(deployed.ruleSetName);
      expect(names).not.toContain(name);

      yield* stack.destroy();

      yield* expectGone(projectId, region, name);
      yield* expectGone(projectId, region, deployed.ruleSetName);
    }).pipe(logLevel),
  options,
);
