import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as waf from "@distilled.cloud/stackit/alb_waf";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

// Configurations are free, so this suite is ungated.
const options = { tags: stackitTags("waf", "configuration"), timeout: 300_000 } as const;

const observe = (projectId: string, region: string, name: string) =>
  waf
    .getWAF({ projectId, region, name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)));

const expectGone = (projectId: string, region: string, name: string) =>
  observe(projectId, region, name).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (configuration) => configuration === "gone",
      times: 10,
    }),
    Effect.map((configuration) => expect(configuration).toEqual("gone")),
  );

const denyAdmin = [
  {
    behavior: { action: "ACTION_DENY" as const },
    conditions: [
      {
        variable: { type: "VARIABLE_REQUEST_URI_RAW" as const },
        operator: { type: "OPERATOR_BEGINS_WITH" as const, value: "/admin" },
      },
    ],
  },
];

test.provider(
  "create, update and delete a configuration",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      // Both rule resources stay deployed through every step.
      const lifecycle = (props: {
        managed?: boolean;
        custom?: boolean;
        labels: Record<string, string>;
      }) =>
        Effect.gen(function* () {
          const rules = yield* Stackit.WAF.ManagedRuleSet("LifecycleOwasp", {});
          const group = yield* Stackit.WAF.CustomRuleGroup("LifecycleBlocks", { rules: denyAdmin });
          const firewall = yield* Stackit.WAF.Configuration("Lifecycle", {
            ...(props.managed ? { managedRuleSetName: rules.ruleSetName } : {}),
            ...(props.custom ? { customRuleGroupName: group.ruleGroupName } : {}),
            labels: props.labels,
          });
          return { firewall, rules, group };
        });

      const created = yield* stack.deploy(
        lifecycle({ managed: true, labels: { env: "test", keep: "yes" } }),
      );
      const name = created.firewall.configurationName;
      expect(name).toMatch(/^[0-9a-z-]+$/);
      expect(created.firewall.managedRuleSetName).toEqual(created.rules.ruleSetName);
      expect(created.firewall.customRuleGroupName).toBeUndefined();
      expect(created.firewall.labels).toEqual({ env: "test", keep: "yes" });
      expect(created.firewall.projectId).toEqual(projectId);
      expect(created.firewall.region).toEqual(region);

      // Out of band: the references and Alchemy's ownership labels.
      const fetched = yield* waf.getWAF({ projectId, region, name });
      expect(fetched.managedRuleSetName).toEqual(created.rules.ruleSetName);
      expect(Stackit.labelRecord(fetched.labels)).toMatchObject({
        env: "test",
        keep: "yes",
        "alchemy.id": "Lifecycle",
      });

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(
        lifecycle({ managed: true, labels: { env: "test", keep: "yes" } }),
      );
      expect(plan.resources.Lifecycle).toMatchObject({ action: "noop" });

      // Update in place: same name, a second reference, new labels.
      const updated = yield* stack.deploy(
        lifecycle({ managed: true, custom: true, labels: { env: "prod" } }),
      );
      expect(updated.firewall.configurationName).toEqual(name);
      const refetched = yield* waf.getWAF({ projectId, region, name });
      expect(refetched.managedRuleSetName).toEqual(created.rules.ruleSetName);
      expect(refetched.customRuleGroupName).toEqual(updated.group.ruleGroupName);
      expect(Stackit.stripInternalLabels(refetched.labels)).toEqual({ env: "prod" });

      // Removing a reference clears it, and leaves the other.
      yield* stack.deploy(lifecycle({ custom: true, labels: { env: "prod" } }));
      const cleared = yield* waf.getWAF({ projectId, region, name });
      expect(cleared.managedRuleSetName ?? "").toEqual("");
      expect(cleared.customRuleGroupName).toEqual(updated.group.ruleGroupName);

      yield* stack.destroy();

      yield* expectGone(projectId, region, name);
    }).pipe(logLevel),
  options,
);

test.provider(
  "a new name replaces create-first and deletes the old configuration",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const nameA = "alchemy-test-waf-config-a";
      const nameB = "alchemy-test-waf-config-b";
      const created = yield* stack.deploy(Stackit.WAF.Configuration("Renamed", { name: nameA }));
      expect(created.configurationName).toEqual(nameA);

      const plan = yield* stack.plan(Stackit.WAF.Configuration("Renamed", { name: nameB }));
      expect(plan.resources.Renamed).toMatchObject({ action: "replace" });

      const renamed = yield* stack.deploy(Stackit.WAF.Configuration("Renamed", { name: nameB }));
      expect(renamed.configurationName).toEqual(nameB);
      yield* expectGone(projectId, region, nameA);

      yield* stack.destroy();

      yield* expectGone(projectId, region, nameB);
    }).pipe(logLevel),
  options,
);

test.provider(
  "recreates a configuration deleted out of band",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stackit.WAF.Configuration("Recreated", { labels: { step: "one" } }),
      );
      const name = created.configurationName;

      yield* waf.deleteWAF({ projectId, region, name });
      yield* expectGone(projectId, region, name);

      const recreated = yield* stack.deploy(
        Stackit.WAF.Configuration("Recreated", { labels: { step: "two" } }),
      );
      expect(recreated.configurationName).toEqual(name);
      const fetched = yield* waf.getWAF({ projectId, region, name });
      expect(Stackit.stripInternalLabels(fetched.labels)).toEqual({ step: "two" });

      yield* stack.destroy();

      yield* expectGone(projectId, region, name);
    }).pipe(logLevel),
  options,
);

test.provider(
  "refuses to take over a configuration another logical id owns, and list finds its own",
  (stack) =>
    Effect.gen(function* () {
      const { projectId, region } = yield* stackitEnvironment;
      yield* stack.destroy();

      const name = "alchemy-test-waf-config-foreign";
      // Another logical id stands in for someone else: its labels aren't this resource's.
      const foreign = Stackit.WAF.Configuration("Foreign", { name });
      yield* stack.deploy(foreign);

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* foreign;
            yield* Stackit.WAF.Configuration("Claimant", { name });
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("OwnedBySomeoneElse");

      const provider = yield* Provider.findProvider(Stackit.WAF.Configuration);
      const all = yield* provider.list();
      expect(all.map((configuration) => configuration.configurationName)).toContain(name);

      yield* stack.destroy();

      yield* expectGone(projectId, region, name);
    }).pipe(logLevel),
  options,
);
