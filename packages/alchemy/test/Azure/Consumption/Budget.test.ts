import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as consumption from "@distilled.cloud/azure/consumption";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const tags = ["provider:azure", "provider:azure:consumption", "live"];

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getBudget = (scope: string, budgetName: string) =>
  consumption.GetBudget({ scope, budgetName });

/** Poll an out-of-band GET until it reports the typed not-found. */
const waitGone = (scope: string, budgetName: string) =>
  getBudget(scope, budgetName).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 20,
    }),
  );

const program = (props: {
  amount: number;
  threshold: number;
  inGroup: boolean;
}) =>
  Effect.gen(function* () {
    // The group stays deployed across the scope-change replacement.
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const budget = yield* Azure.Consumption.Budget("Budget", {
      scope: props.inGroup ? group.resourceGroupId : undefined,
      amount: props.amount,
      notifications: {
        actual: {
          operator: "GreaterThan",
          threshold: props.threshold,
          contactEmails: ["alerts@example.com"],
        },
      },
    });
    return { group, budget };
  });

// Budgets are free and synchronous.
test.provider(
  "create, update, replace, and delete a budget",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      const subscriptionScope = `/subscriptions/${subscriptionId}`;

      const { budget } = yield* stack.deploy(
        program({ amount: 10, threshold: 80, inGroup: false }),
      );
      expect(budget.scope).toEqual(subscriptionScope);
      expect(budget.timeGrain).toEqual("Monthly");
      const observed = yield* getBudget(subscriptionScope, budget.budgetName);
      expect(observed.properties?.amount).toEqual(10);
      expect(observed.properties?.notifications?.actual?.threshold).toEqual(80);
      expect(observed.properties?.notifications?.actual?.contactEmails).toEqual(
        ["alerts@example.com"],
      );

      // In place: amount and notification threshold are mutable.
      const updated = yield* stack.deploy(
        program({ amount: 25, threshold: 90, inGroup: false }),
      );
      expect(updated.budget.budgetId).toEqual(budget.budgetId);
      expect(updated.budget.amount).toEqual(25);
      const reobserved = yield* getBudget(subscriptionScope, budget.budgetName);
      expect(reobserved.properties?.amount).toEqual(25);
      expect(reobserved.properties?.notifications?.actual?.threshold).toEqual(
        90,
      );
      expect(reobserved.properties?.timePeriod.startDate).toEqual(
        observed.properties?.timePeriod.startDate,
      );

      // Replacement: moving the budget to the resource group scope.
      const replaced = yield* stack.deploy(
        program({ amount: 25, threshold: 90, inGroup: true }),
      );
      expect(replaced.budget.scope.toLowerCase()).toEqual(
        replaced.group.resourceGroupId.toLowerCase(),
      );
      const groupObserved = yield* getBudget(
        replaced.budget.scope,
        replaced.budget.budgetName,
      );
      expect(groupObserved.properties?.amount).toEqual(25);
      expect(yield* waitGone(subscriptionScope, budget.budgetName)).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(replaced.budget.scope, replaced.budget.budgetName),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
