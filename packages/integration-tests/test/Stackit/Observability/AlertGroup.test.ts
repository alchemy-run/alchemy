import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as observability from "@distilled.cloud/stackit/observability";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { expectGone, observeInstance, slow } from "./observability.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("observability", "alertgroup"),
  timeout: 2_700_000,
} as const;

/** The instance, plus the group when props are given. */
const app = (props?: Omit<Stackit.Observability.AlertGroupProps, "instanceId">) =>
  Effect.gen(function* () {
    const instance = yield* Stackit.Observability.Instance("AlertGroupInstance", {});
    if (props === undefined) return { instance, group: undefined };
    return {
      instance,
      group: yield* Stackit.Observability.AlertGroup("GroupUnderTest", {
        instanceId: instance.instanceId,
        ...props,
      }),
    };
  });

const observeGroup = (projectId: string, instanceId: string, groupName: string) =>
  observability.getAlertgroup({ projectId, instanceId, groupName }).pipe(
    Effect.map(({ data }) => data),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
  );

const unwrap = (group: observability.AlertGroup | "gone") => {
  if (group === "gone") throw new Error("The group is gone");
  return group;
};

const RULE = {
  alert: "AlchemyTestAlert",
  expr: "vector(1) > 2",
  for: "2m",
  labels: { severity: "test", keep: "yes" },
  annotations: { summary: "alchemy test alert" },
};

test.provider.skipIf(slow)(
  "create, update, replace and delete an alert group",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const props = { rules: [RULE] };
      const created = yield* stack.deploy(app(props));
      const instanceId = created.instance.instanceId;
      const group = created.group!;

      expect(group.instanceId).toEqual(instanceId);
      expect(group.name).toMatch(/^[a-z0-9-]+$/);

      // Out of band.
      const fetched = unwrap(yield* observeGroup(projectId, instanceId, group.name));
      expect(fetched.rules).toHaveLength(1);
      expect(fetched.rules[0]!.alert).toEqual("AlchemyTestAlert");
      expect(fetched.rules[0]!.expr).toEqual(RULE.expr);
      expect(fetched.rules[0]!.labels).toEqual(RULE.labels);

      // `list` enumerates it, by its generated name.
      const provider = yield* Provider.findProvider(Stackit.Observability.AlertGroup);
      const listed = yield* provider.list();
      expect(listed.find((entry) => entry.name === group.name)?.instanceId).toEqual(instanceId);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(app(props));
      expect(plan.resources.GroupUnderTest).toMatchObject({ action: "noop" });

      // Update in place: a removed label, another rule and a new interval reach the group.
      const updated = yield* stack.deploy(
        app({
          interval: "5m",
          rules: [
            { ...RULE, labels: { severity: "test" } },
            { record: "alchemy:test:recorded", expr: "vector(1)" },
          ],
        }),
      );
      expect(updated.group!.name).toEqual(group.name);
      const refetched = unwrap(yield* observeGroup(projectId, instanceId, group.name));
      expect(refetched.rules).toHaveLength(2);
      expect(refetched.rules.find((rule) => rule.alert !== undefined)!.labels).toEqual({
        severity: "test",
      });
      expect(refetched.rules.find((rule) => rule.record !== undefined)!.record).toEqual(
        "alchemy:test:recorded",
      );

      // Renaming replaces, and the old group goes.
      const renamed = yield* stack.deploy(app({ ...props, name: "alchemy-test-group-renamed" }));
      expect(renamed.group!.name).toEqual("alchemy-test-group-renamed");
      yield* expectGone(observeGroup(projectId, instanceId, group.name));

      // Removing it from the stack deletes it and leaves the instance.
      yield* stack.deploy(app());
      yield* expectGone(observeGroup(projectId, instanceId, "alchemy-test-group-renamed"));
      const instance = yield* observeInstance(projectId, instanceId);
      expect(instance === "gone" ? "gone" : "present").toEqual("present");

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, instanceId));
    }).pipe(logLevel),
  options,
);
