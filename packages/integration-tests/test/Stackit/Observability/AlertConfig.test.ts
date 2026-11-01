import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as observability from "@distilled.cloud/stackit/observability";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, observeInstance, slow } from "./observability.ts";

const { test } = makeStackitTest();

// The configuration is a singleton, and this suite's instance is its own, so no other
// suite can write to it.
const options = {
  tags: stackitTags("observability", "alertconfig"),
  timeout: 2_700_000,
} as const;

/** The instance, plus the configuration when props are given. */
const app = (props?: Omit<Stackit.Observability.AlertConfigProps, "instanceId">) =>
  Effect.gen(function* () {
    const instance = yield* Stackit.Observability.Instance("AlertConfigInstance", {});
    if (props === undefined) return { instance, config: undefined };
    return {
      instance,
      config: yield* Stackit.Observability.AlertConfig("ConfigUnderTest", {
        instanceId: instance.instanceId,
        ...props,
      }),
    };
  });

const SMTP_PASSWORD = "alchemy-test-smtp-password";

const RULE = {
  equal: ["alertname"],
  sourceMatch: { severity: "critical" },
  targetMatch: { severity: "warning" },
};

const WEBHOOK_TOKEN = "https://alerts.example.com/hook?token=alchemy-test-webhook-token";

const receivers = [
  { name: "team", emailConfigs: [{ to: "team@example.com" }] },
  {
    name: "hook",
    webHookConfigs: [{ url: Redacted.make(WEBHOOK_TOKEN), sendResolved: true }],
  },
];

test.provider.skipIf(slow)(
  "capture, update and restore an alert configuration",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      // What the instance has before Alchemy writes anything.
      const { instance } = yield* stack.deploy(app());
      const scope = { projectId, instanceId: instance.instanceId };
      const before = yield* observability.getAlertConfigs(scope);
      const beforeReceivers = before.data.receivers.map((receiver) => receiver.name);

      // What an instance starts with isn't documented. Rules the API's update can't write
      // stop the first deploy until that is accepted.
      const rules = before.data.inhibitRules ?? [];
      const needsOptIn =
        rules.length > 1 ||
        rules.some(
          (rule) =>
            (rule.sourceMatchers?.length ?? 0) > 0 || (rule.targetMatchers?.length ?? 0) > 0,
        );
      const props = {
        receivers,
        route: {
          receiver: "team",
          groupBy: ["alertname"],
          groupInterval: "5m",
          routes: [{ receiver: "hook", matchers: ['severity="critical"'] }],
        },
      };
      if (needsOptIn) {
        const refused = yield* stack.deploy(app(props)).pipe(Effect.flip);
        expect(refused._tag).toEqual("Stackit.Observability.InhibitRulesWouldBeLost");
        const untouched = yield* observability.getAlertConfigs(scope);
        expect(untouched.data.inhibitRules).toHaveLength(rules.length);
      }
      const accepted = needsOptIn ? { replaceInhibitRules: true } : {};
      const created = yield* stack.deploy(app({ ...props, ...accepted }));
      const config = created.config!;
      expect(config.instanceId).toEqual(instance.instanceId);
      expect([...config.receivers].sort()).toEqual(["hook", "team"]);
      expect(config.route.receiver).toEqual("team");
      // What is live is in the attributes without its secrets.
      expect(JSON.stringify(config.route)).not.toContain("alchemy-test-webhook-token");

      // Out of band.
      const live = yield* observability.getAlertConfigs(scope);
      expect(live.data.route.receiver).toEqual("team");
      expect(live.data.route.routes?.[0]?.receiver).toEqual("hook");
      const hook = live.data.receivers.find((receiver) => receiver.name === "hook");
      expect(Redacted.isRedacted(hook?.webHookConfigs?.[0]?.url)).toEqual(true);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app({ ...props, ...accepted }));
      expect(plan.resources.ConfigUnderTest).toMatchObject({ action: "noop" });

      // Update in place, without capturing Alchemy's own configuration.
      const updated = yield* stack.deploy(
        app({
          receivers: [receivers[0]!],
          route: { receiver: "team", groupBy: ["alertname", "job"] },
          ...accepted,
        }),
      );
      expect(updated.config!.receivers).toEqual(["team"]);
      expect(updated.config!.captured.receivers.map((receiver) => receiver.name)).toEqual(
        beforeReceivers,
      );
      const changed = yield* observability.getAlertConfigs(scope);
      expect(changed.data.receivers.map((receiver) => receiver.name)).toEqual(["team"]);
      expect(changed.data.route.routes ?? []).toEqual([]);

      // Deleting it writes back what was captured, and leaves the instance.
      yield* stack.deploy(app());
      const restored = yield* observability.getAlertConfigs(scope);
      expect(restored.data.receivers.map((receiver) => receiver.name)).toEqual(beforeReceivers);
      expect(restored.data.route.receiver).toEqual(before.data.route.receiver);

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, instance.instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow)(
  "a rule and a secret the props don't declare survive an update and the restore",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const { instance } = yield* stack.deploy(app());
      const scope = { projectId, instanceId: instance.instanceId };

      // Out of band: an inhibition rule, and SMTP defaults with their password.
      const { data: start } = yield* observability.getAlertConfigs(scope);
      const { matchers: _matchers, ...startRoute } = start.route;
      yield* observability.updateAlertConfigs({
        ...scope,
        receivers: start.receivers,
        route: startRoute,
        global: { smtpFrom: "alerts@example.com", smtpAuthPassword: Redacted.make(SMTP_PASSWORD) },
        inhibitRules: RULE,
      });
      const carries = (config: observability.Alert) => {
        expect(config.inhibitRules).toHaveLength(1);
        expect(config.inhibitRules?.[0]).toMatchObject(RULE);
        const password = config.global?.smtpAuthPassword;
        expect(Redacted.isRedacted(password) ? Redacted.value(password) : password).toEqual(
          SMTP_PASSWORD,
        );
      };
      yield* observability.getAlertConfigs(scope).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: ({ data }) => (data.inhibitRules?.length ?? 0) === 1,
          times: 30,
        }),
      );

      // The first write leaves them alone.
      const route = { receiver: "team", groupBy: ["alertname"] };
      yield* stack.deploy(app({ receivers: [receivers[0]!], route }));
      carries((yield* observability.getAlertConfigs(scope)).data);

      // So does an unrelated edit.
      yield* stack.deploy(
        app({ receivers: [receivers[0]!], route: { ...route, groupBy: ["alertname", "job"] } }),
      );
      carries((yield* observability.getAlertConfigs(scope)).data);

      // And the restore: what it captured is what was seeded.
      yield* stack.deploy(app());
      carries((yield* observability.getAlertConfigs(scope)).data);

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, instance.instanceId));
    }).pipe(logLevel),
  options,
);
