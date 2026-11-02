import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as observability from "@distilled.cloud/stackit/observability";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import {
  expectGone,
  MONITORING_PLAN,
  observeInstance,
  slow,
  STARTER_PLAN,
} from "./observability.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("observability", "instance"),
  timeout: 3_000_000,
} as const;

const unwrap = (instance: observability.GetInstanceResponse | "gone") => {
  if (instance === "gone") throw new Error("The instance is gone");
  return instance;
};

test.provider.skipIf(slow)(
  "create, update, change plan and delete an instance",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = {
        acl: ["203.0.113.0/24"],
        metricsRetentionDays: 30,
        metricsRetentionDays5m: 30,
        metricsRetentionDays1h: 30,
      };
      const created = yield* stack.deploy(Stackit.Observability.Instance("Instance", props));
      const scope = { projectId, instanceId: created.instanceId };

      expect(created.projectId).toEqual(projectId);
      expect(created.planName).toEqual(MONITORING_PLAN);
      expect(created.name).toMatch(/^[a-z0-9-]+$/);
      expect(created.acl).toEqual(["203.0.113.0/24"]);
      expect(created.metricsRetentionDays).toEqual(30);
      expect(created.logsRetentionDays).toEqual(undefined);
      expect(created.grafanaUrl).toMatch(/^https:/);
      expect(created.pushMetricsUrl).toMatch(/^https:/);

      // Out of band.
      const fetched = unwrap(yield* observeInstance(projectId, created.instanceId));
      expect(fetched.status === "CREATE_SUCCEEDED" || fetched.status === "UPDATE_SUCCEEDED").toBe(
        true,
      );
      expect(fetched.name).toEqual(created.name);
      expect(fetched.instance.grafanaAdminEnabled).toEqual(false);
      expect((yield* observability.listACL(scope)).acl).toEqual(["203.0.113.0/24"]);
      const retention = yield* observability.getMetricsStorageRetention(scope);
      expect(retention.metricsRetentionTimeRaw).toEqual("30d");

      // `list` enumerates it, by its generated name.
      const provider = yield* Provider.findProvider(Stackit.Observability.Instance);
      const listed = yield* provider.list();
      expect(listed.find((entry) => entry.instanceId === created.instanceId)?.name).toEqual(
        created.name,
      );

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.Observability.Instance("Instance", props));
      expect(plan.resources.Instance).toMatchObject({ action: "noop" });

      // A plan without logs refuses logs retention, and nothing is left half done.
      const refused = yield* Effect.exit(
        stack.deploy(
          Stackit.Observability.Instance("Instance", { ...props, logsRetentionDays: 10 }),
        ),
      );
      expect(Exit.isFailure(refused)).toBe(true);

      // Update in place.
      const updated = yield* stack.deploy(
        Stackit.Observability.Instance("Instance", {
          ...props,
          name: "alchemy-observability-instance-test",
          acl: ["203.0.113.0/24", "198.51.100.7/32"],
          metricsRetentionDays: 20,
        }),
      );
      expect(updated.instanceId).toEqual(created.instanceId);
      expect(updated.name).toEqual("alchemy-observability-instance-test");
      const renamed = unwrap(yield* observeInstance(projectId, created.instanceId));
      expect(renamed.name).toEqual("alchemy-observability-instance-test");
      expect([...(yield* observability.listACL(scope)).acl].sort()).toEqual([
        "198.51.100.7/32",
        "203.0.113.0/24",
      ]);
      const changed = yield* observability.getMetricsStorageRetention(scope);
      expect(changed.metricsRetentionTimeRaw).toEqual("20d");
      expect(changed.metricsRetentionTime5m).toEqual("30d");

      // A plan with logs and traces takes their retention, in hours on the wire.
      const upgraded = yield* stack.deploy(
        Stackit.Observability.Instance("Instance", {
          ...props,
          name: "alchemy-observability-instance-test",
          plan: STARTER_PLAN,
          logsRetentionDays: 10,
          tracesRetentionDays: 12,
        }),
      );
      expect(upgraded.instanceId).toEqual(created.instanceId);
      expect(upgraded.planName).toEqual(STARTER_PLAN);
      expect(upgraded.logsRetentionDays).toEqual(10);
      expect(upgraded.tracesRetentionDays).toEqual(12);
      expect((yield* observability.getLogsConfigs(scope)).config.retention).toEqual("240h");
      expect((yield* observability.getTracesConfigs(scope)).config.retention).toEqual("288h");

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, created.instanceId));
    }).pipe(logLevel),
  options,
);
