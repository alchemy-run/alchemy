import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as durabletask from "@distilled.cloud/azure/durabletask";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const LOCATION = "westus2";

const getPolicy = (resourceGroupName: string, schedulerName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* durabletask.GetRetentionPolicy({
      subscriptionId,
      resourceGroupName,
      schedulerName,
    });
  });

const rules = (policy: durabletask.GetRetentionPolicyResponse) =>
  (policy.properties?.retentionPolicies ?? [])
    .map((r) => `${r.orchestrationState ?? "*"}=${r.retentionPeriodInDays}`)
    .sort();

const policyGone = (resourceGroupName: string, schedulerName: string) =>
  getPolicy(resourceGroupName, schedulerName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (retentionPolicies?: Azure.DurableTask.RetentionRule[]) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const scheduler = yield* Azure.DurableTask.Scheduler("Scheduler", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
    });
    const policy = retentionPolicies
      ? yield* Azure.DurableTask.RetentionPolicy("Retention", {
          resourceGroup: group.resourceGroupName,
          scheduler: scheduler.schedulerName,
          retentionPolicies,
        })
      : undefined;
    return { group, scheduler, policy };
  });

// Consumption scheduler + retention policy: billed per action, ~$0 idle.
// Scheduler provisioning takes ~3-8 minutes.
test.provider(
  "create, update, and delete a durable task retention policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program([
          { retentionPeriodInDays: 7 },
          { retentionPeriodInDays: 30, orchestrationState: "Failed" },
        ]),
      );
      const rg = created.group.resourceGroupName;
      const scheduler = created.scheduler.schedulerName;
      expect(created.policy!.retentionPolicies).toHaveLength(2);
      expect(rules(yield* getPolicy(rg, scheduler))).toEqual([
        "*=7",
        "Failed=30",
      ]);

      // In-place update of the rules.
      const updated = yield* stack.deploy(
        program([
          { retentionPeriodInDays: 3 },
          { retentionPeriodInDays: 14, orchestrationState: "Terminated" },
        ]),
      );
      expect(updated.policy!.retentionPolicyId).toEqual(
        created.policy!.retentionPolicyId,
      );
      expect(rules(yield* getPolicy(rg, scheduler))).toEqual([
        "*=3",
        "Terminated=14",
      ]);

      // Removing the policy from the stack deletes it.
      yield* stack.deploy(program());
      expect(yield* policyGone(rg, scheduler)).toEqual("gone");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:durabletask", "live"],
    timeout: 900_000,
  },
);
