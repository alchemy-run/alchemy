import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cm from "@distilled.cloud/azure/cost_management";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// A Monthly budget may not start before the current month.
const now = new Date();
const startDate = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;

const budgetGone = (scope: string, budgetName: string) =>
  cm.GetBudget({ scope, budgetName }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const program = (props: {
  amount: number;
  threshold: number;
  timeGrain?: Azure.CostManagement.BudgetTimeGrain;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const budget = yield* Azure.CostManagement.Budget("Budget", {
      scope: group.resourceGroupId,
      amount: props.amount,
      timeGrain: props.timeGrain,
      startDate,
      notifications: {
        actual: {
          enabled: true,
          operator: "GreaterThan",
          threshold: props.threshold,
          contactEmails: ["alchemy-budget-test@example.com"],
        },
      },
    });
    return { group, budget };
  });

// Budgets are free and synchronous.
test.provider(
  "create, update, replace and delete a resource-group budget",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, budget } = yield* stack.deploy(
        program({ amount: 50, threshold: 80 }),
      );
      expect(budget.amount).toEqual(50);
      expect(budget.timeGrain).toEqual("Monthly");
      expect(budget.startDate).toEqual(startDate);
      expect(budget.scope.toLowerCase()).toEqual(
        group.resourceGroupId.toLowerCase(),
      );
      const observed = yield* cm.GetBudget({
        scope: budget.scope,
        budgetName: budget.budgetName,
      });
      expect(observed.properties?.amount).toEqual(50);
      expect(observed.properties?.notifications?.actual?.threshold).toEqual(80);

      // Amount and notifications update in place.
      const updated = yield* stack.deploy(
        program({ amount: 75, threshold: 90 }),
      );
      expect(updated.budget.budgetName).toEqual(budget.budgetName);
      const reobserved = yield* cm.GetBudget({
        scope: budget.scope,
        budgetName: budget.budgetName,
      });
      expect(reobserved.properties?.amount).toEqual(75);
      expect(reobserved.properties?.notifications?.actual?.threshold).toEqual(
        90,
      );

      // Changing the time grain replaces the budget.
      const replaced = yield* stack.deploy(
        program({ amount: 75, threshold: 90, timeGrain: "Quarterly" }),
      );
      expect(replaced.budget.budgetName).not.toEqual(budget.budgetName);
      expect(replaced.budget.timeGrain).toEqual("Quarterly");
      const replacement = yield* cm.GetBudget({
        scope: replaced.budget.scope,
        budgetName: replaced.budget.budgetName,
      });
      expect(replacement.properties?.timeGrain).toEqual("Quarterly");
      expect(yield* budgetGone(budget.scope, budget.budgetName)).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* budgetGone(replaced.budget.scope, replaced.budget.budgetName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:costmanagement", "live"],
    timeout: 600_000,
  },
);
