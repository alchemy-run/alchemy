import * as AWS from "@/AWS";
import { Budget } from "@/AWS/Budgets/Budget.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as budgets from "@distilled.cloud/aws/budgets";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const budgetName = "alchemy-test-budget-lifecycle";

const getBudget = (accountId: string) =>
  budgets.describeBudget({ AccountId: accountId, BudgetName: budgetName }).pipe(
    Effect.map((r) => r.Budget),
    Effect.catchTag("NotFoundException", () => Effect.succeed(undefined)),
  );

test.provider(
  "lifecycle: create cost budget with notification, update limit, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const budget = yield* Budget("LifecycleBudget", {
            budgetName,
            budgetType: "COST",
            timeUnit: "MONTHLY",
            budgetLimit: { amount: "100", unit: "USD" },
            notifications: [
              {
                notificationType: "ACTUAL",
                comparisonOperator: "GREATER_THAN",
                threshold: 80,
                thresholdType: "PERCENTAGE",
                subscribers: [
                  {
                    subscriptionType: "EMAIL",
                    address: "budget-test@example.com",
                  },
                ],
              },
            ],
          });
          return { accountId: budget.accountId };
        }),
      );

      const accountId = deployed.accountId;

      // Out-of-band verification via distilled.
      const created = yield* getBudget(accountId);
      expect(created?.BudgetName).toBe(budgetName);
      expect(Number(created?.BudgetLimit?.Amount)).toBe(100);
      expect(created?.BudgetLimit?.Unit).toBe("USD");
      expect(created?.TimeUnit).toBe("MONTHLY");

      const notifications = yield* budgets.describeNotificationsForBudget({
        AccountId: accountId,
        BudgetName: budgetName,
      });
      expect(notifications.Notifications?.length).toBe(1);
      expect(notifications.Notifications?.[0]?.Threshold).toBe(80);

      // Canonical list() coverage.
      const provider = yield* Provider.findProvider(Budget);
      const all = yield* provider.list();
      expect(all.some((b) => b.budgetName === budgetName)).toBe(true);

      // Update — raise the limit and drop the notification.
      yield* stack.deploy(
        Effect.gen(function* () {
          const budget = yield* Budget("LifecycleBudget", {
            budgetName,
            budgetType: "COST",
            timeUnit: "MONTHLY",
            budgetLimit: { amount: "250", unit: "USD" },
          });
          return { accountId: budget.accountId };
        }),
      );

      const updated = yield* getBudget(accountId);
      expect(Number(updated?.BudgetLimit?.Amount)).toBe(250);
      const updatedNotifs = yield* budgets
        .describeNotificationsForBudget({
          AccountId: accountId,
          BudgetName: budgetName,
        })
        .pipe(
          Effect.map((r) => r.Notifications ?? []),
          Effect.catchTag("NotFoundException", () => Effect.succeed([])),
        );
      expect(updatedNotifs.length).toBe(0);

      // Destroy — the budget is gone.
      yield* stack.destroy();
      const after = yield* getBudget(accountId);
      expect(after).toBeUndefined();
    }),
  { timeout: 180_000 },
);
