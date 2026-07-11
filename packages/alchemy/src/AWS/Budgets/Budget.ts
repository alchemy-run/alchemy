import * as budgets from "@distilled.cloud/aws/budgets";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/**
 * A subscriber notified when a budget notification is triggered.
 */
export interface BudgetSubscriber {
  /**
   * How the subscriber is notified.
   */
  subscriptionType: "EMAIL" | "SNS" | (string & {});
  /**
   * The destination — an email address (for `EMAIL`) or an SNS topic ARN
   * (for `SNS`).
   */
  address: string;
}

/**
 * A threshold that, when crossed, notifies the configured subscribers.
 */
export interface BudgetNotification {
  /**
   * Whether the notification is based on actual or forecasted spend/usage.
   */
  notificationType: "ACTUAL" | "FORECASTED" | (string & {});
  /**
   * How the actual/forecasted amount is compared to the threshold.
   */
  comparisonOperator: "GREATER_THAN" | "LESS_THAN" | "EQUAL_TO" | (string & {});
  /**
   * The threshold value. Interpreted as a percentage of the budget limit by
   * default, or an absolute amount when `thresholdType` is `ABSOLUTE_VALUE`.
   */
  threshold: number;
  /**
   * Whether `threshold` is a percentage of the budget or an absolute value.
   * @default "PERCENTAGE"
   */
  thresholdType?: "PERCENTAGE" | "ABSOLUTE_VALUE" | (string & {});
  /**
   * Subscribers notified when this threshold is crossed.
   */
  subscribers: BudgetSubscriber[];
}

export interface BudgetProps {
  /**
   * Name of the budget. Must be unique within the account. If omitted, a
   * unique name is generated from the app, stage, and logical ID.
   *
   * Changing the name replaces the budget.
   */
  budgetName?: string;
  /**
   * What the budget tracks.
   * @default "COST"
   */
  budgetType?:
    | "COST"
    | "USAGE"
    | "RI_UTILIZATION"
    | "RI_COVERAGE"
    | "SAVINGS_PLANS_UTILIZATION"
    | "SAVINGS_PLANS_COVERAGE"
    | (string & {});
  /**
   * The period the budget resets over.
   * @default "MONTHLY"
   */
  timeUnit?: "DAILY" | "MONTHLY" | "QUARTERLY" | "ANNUALLY" | (string & {});
  /**
   * The budgeted amount and its unit, e.g. `{ amount: "100", unit: "USD" }`.
   * Required for `COST` and `USAGE` budgets.
   */
  budgetLimit?: {
    /** The amount, as a string, e.g. `"100"`. */
    amount: string;
    /** The unit — `"USD"` for cost budgets, or the usage unit. */
    unit: string;
  };
  /**
   * Cost filters restricting which costs count against the budget, e.g.
   * `{ Service: ["Amazon Elastic Compute Cloud - Compute"] }`.
   */
  costFilters?: Record<string, string[]>;
  /**
   * Notifications and their subscribers.
   */
  notifications?: BudgetNotification[];
  /**
   * Tags applied to the budget at creation.
   */
  tags?: Record<string, string>;
}

export interface Budget extends Resource<
  "AWS.Budgets.Budget",
  BudgetProps,
  {
    /**
     * Name of the budget.
     */
    budgetName: string;
    /**
     * The AWS account ID that owns the budget.
     */
    accountId: string;
  },
  never,
  Providers
> {}

/**
 * An AWS Budget — tracks cost or usage against a defined limit over a time
 * period and notifies subscribers when configured thresholds are crossed.
 *
 * Budgets are a global (account-level) resource; they are free and take
 * effect immediately.
 *
 * @resource
 * @section Creating a Budget
 * @example Monthly cost budget with an email alert at 80%
 * ```typescript
 * import * as Budgets from "alchemy/AWS/Budgets";
 *
 * const budget = yield* Budgets.Budget("MonthlyCost", {
 *   budgetType: "COST",
 *   timeUnit: "MONTHLY",
 *   budgetLimit: { amount: "100", unit: "USD" },
 *   notifications: [
 *     {
 *       notificationType: "ACTUAL",
 *       comparisonOperator: "GREATER_THAN",
 *       threshold: 80,
 *       thresholdType: "PERCENTAGE",
 *       subscribers: [{ subscriptionType: "EMAIL", address: "team@example.com" }],
 *     },
 *   ],
 * });
 * ```
 *
 * @example Budget scoped to a single service
 * ```typescript
 * const budget = yield* Budgets.Budget("EC2Spend", {
 *   budgetLimit: { amount: "500", unit: "USD" },
 *   costFilters: {
 *     Service: ["Amazon Elastic Compute Cloud - Compute"],
 *   },
 * });
 * ```
 */
export const Budget = Resource<Budget>("AWS.Budgets.Budget");

const notificationKey = (n: budgets.Notification): string =>
  JSON.stringify({
    NotificationType: n.NotificationType,
    ComparisonOperator: n.ComparisonOperator,
    Threshold: n.Threshold,
    ThresholdType: n.ThresholdType ?? "PERCENTAGE",
  });

const toNotification = (n: BudgetNotification): budgets.Notification => ({
  NotificationType: n.notificationType,
  ComparisonOperator: n.comparisonOperator,
  Threshold: n.threshold,
  ThresholdType: n.thresholdType ?? "PERCENTAGE",
});

export const BudgetProvider = () =>
  Provider.effect(
    Budget,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { budgetName?: string | undefined },
      ) {
        return (
          props.budgetName ??
          (yield* createPhysicalName({ id, maxLength: 100 }))
        );
      });

      const buildBudget = (
        name: string,
        props: BudgetProps,
      ): budgets.Budget => ({
        BudgetName: name,
        BudgetType: props.budgetType ?? "COST",
        TimeUnit: props.timeUnit ?? "MONTHLY",
        BudgetLimit: props.budgetLimit
          ? { Amount: props.budgetLimit.amount, Unit: props.budgetLimit.unit }
          : undefined,
        CostFilters: props.costFilters,
      });

      const syncNotifications = Effect.fn(function* (
        accountId: string,
        name: string,
        desired: BudgetNotification[],
      ) {
        const current = yield* budgets.describeNotificationsForBudget
          .pages({
            AccountId: accountId,
            BudgetName: name,
          })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.Notifications ?? []),
            ),
            Effect.catchTag("NotFoundException", () => Effect.succeed([])),
          );
        const currentKeys = new Set(current.map(notificationKey));
        const desiredNotifs = desired.map(toNotification);
        const desiredKeys = new Set(desiredNotifs.map(notificationKey));

        for (const n of desired) {
          const notif = toNotification(n);
          if (currentKeys.has(notificationKey(notif))) continue;
          yield* budgets.createNotification({
            AccountId: accountId,
            BudgetName: name,
            Notification: notif,
            Subscribers: n.subscribers.map((s) => ({
              SubscriptionType: s.subscriptionType,
              Address: s.address,
            })),
          });
        }
        for (const n of current) {
          if (desiredKeys.has(notificationKey(n))) continue;
          yield* budgets
            .deleteNotification({
              AccountId: accountId,
              BudgetName: name,
              Notification: n,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }
      });

      return Budget.Provider.of({
        stables: ["budgetName", "accountId"],
        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* AWSEnvironment.current;
            return yield* budgets.describeBudgets
              .pages({ AccountId: accountId })
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk)
                    .flatMap((page) => page.Budgets ?? [])
                    .map((b) => ({
                      budgetName: b.BudgetName,
                      accountId,
                    })),
                ),
                Effect.catchTag("NotFoundException", () => Effect.succeed([])),
              );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId } = yield* AWSEnvironment.current;
          const name =
            output?.budgetName ?? (yield* createName(id, olds ?? {}));
          const found = yield* budgets
            .describeBudget({ AccountId: accountId, BudgetName: name })
            .pipe(
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (!found?.Budget) return undefined;
          return { budgetName: name, accountId };
        }),
        diff: Effect.fn(function* ({ id, news = {}, olds = {} }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const { accountId } = yield* AWSEnvironment.current;
          const name = output?.budgetName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const budgetBody = buildBudget(name, news);

          // OBSERVE — cloud state is authoritative.
          const live = yield* budgets
            .describeBudget({ AccountId: accountId, BudgetName: name })
            .pipe(
              Effect.map((r) => r.Budget),
              Effect.catchTag("NotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          if (!live) {
            // ENSURE — create; tolerate a DuplicateRecord race.
            yield* budgets
              .createBudget({
                AccountId: accountId,
                Budget: budgetBody,
                NotificationsWithSubscribers: news.notifications?.map((n) => ({
                  Notification: toNotification(n),
                  Subscribers: n.subscribers.map((s) => ({
                    SubscriptionType: s.subscriptionType,
                    Address: s.address,
                  })),
                })),
                ResourceTags: Object.entries({
                  ...news.tags,
                  ...internalTags,
                }).map(([Key, Value]) => ({ Key, Value })),
              })
              .pipe(
                Effect.catchTag("DuplicateRecordException", () =>
                  budgets.updateBudget({
                    AccountId: accountId,
                    NewBudget: budgetBody,
                  }),
                ),
              );
          } else {
            // SYNC — updateBudget is a full replace of the budget definition.
            yield* budgets.updateBudget({
              AccountId: accountId,
              NewBudget: budgetBody,
            });
          }

          // SYNC notifications — the budget update does not touch these.
          yield* syncNotifications(accountId, name, news.notifications ?? []);

          yield* session.note(name);
          return { budgetName: name, accountId };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* budgets
            .deleteBudget({
              AccountId: output.accountId,
              BudgetName: output.budgetName,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
