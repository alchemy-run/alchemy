import * as cm from "@distilled.cloud/azure/cost_management";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export type BudgetTimeGrain = cm.TimeGrainType;
export type BudgetFilter = cm.BudgetFilter;
export type BudgetNotification = cm.Notification;

export interface BudgetProps {
  /**
   * ARM ID of the scope the budget tracks: a subscription
   * (`/subscriptions/{id}`) or a resource group (`group.resourceGroupId`).
   * Changing it replaces the budget.
   * @default the current subscription
   */
  scope?: string;
  /**
   * Name of the budget, unique within the scope. Letters, digits, `-` and
   * `_`, at most 63 characters. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the budget.
   */
  budgetName?: string;
  /**
   * Spending limit for each time grain, in the billing currency.
   */
  amount: number;
  /**
   * Period after which tracked spend resets: `Monthly`, `Quarterly` or
   * `Annually` (`Billing*` grains are only available to Web Direct
   * customers). Changing it replaces the budget.
   * @default "Monthly"
   */
  timeGrain?: BudgetTimeGrain;
  /**
   * First day the budget evaluates, as `YYYY-MM-DD`. Must be the first of a
   * month, not before the start of the current time grain and at most
   * twelve months in the future. Changing it replaces the budget.
   */
  startDate: string;
  /**
   * Last day the budget evaluates, as `YYYY-MM-DD`.
   * @default ten years after `startDate`
   */
  endDate?: string;
  /**
   * Narrows tracked cost to resources matching dimensions (e.g.
   * `ResourceId`, `ResourceGroupName`, `MeterCategory`) and/or tags.
   */
  filter?: BudgetFilter;
  /**
   * Alerts keyed by a name of your choice (at most 5 `Actual` and 5
   * `Forecasted`). Each fires when spend crosses `threshold` percent of
   * `amount` and mails `contactEmails`, `contactRoles` (e.g. `Owner`), or
   * action groups in `contactGroups`.
   */
  notifications?: Record<string, BudgetNotification>;
}

export interface Budget extends Resource<
  "Azure.CostManagement.Budget",
  BudgetProps,
  {
    /** Name of the budget. */
    budgetName: string;
    /** ARM ID of the budget. */
    budgetId: string;
    /** Scope the budget tracks. */
    scope: string;
    /** Spending limit per time grain. */
    amount: number;
    /** Period after which tracked spend resets. */
    timeGrain: string;
    /** First day the budget evaluates (`YYYY-MM-DD`). */
    startDate: string;
    /** Last day the budget evaluates (`YYYY-MM-DD`). */
    endDate: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Cost Management budget — a spending limit on a subscription or
 * resource group that sends alerts when actual or forecasted cost crosses
 * a percentage of the limit. Budgets cost nothing and never stop resources.
 *
 * Budgets have no tags or free-form fields, so Alchemy treats a budget as
 * its own when its name is the one Alchemy generated (or recorded) for it.
 *
 * @see https://learn.microsoft.com/azure/cost-management-billing/costs/tutorial-acm-create-budgets
 *
 * ### Subscription Budgets
 * **Example:** Monthly budget with an 80% alert to the subscription owners
 * ```typescript
 * yield* Azure.CostManagement.Budget("monthly", {
 *   amount: 100,
 *   startDate: "2026-10-01",
 *   notifications: {
 *     actual80: {
 *       enabled: true,
 *       operator: "GreaterThan",
 *       threshold: 80,
 *       contactEmails: ["ops@example.com"],
 *       contactRoles: ["Owner"],
 *     },
 *   },
 * });
 * ```
 *
 * ### Resource Group Budgets
 * **Example:** Forecast alert for one resource group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app", {});
 * yield* Azure.CostManagement.Budget("app-budget", {
 *   scope: group.resourceGroupId,
 *   amount: 25,
 *   timeGrain: "Quarterly",
 *   startDate: "2026-10-01",
 *   notifications: {
 *     forecast100: {
 *       enabled: true,
 *       operator: "GreaterThan",
 *       threshold: 100,
 *       thresholdType: "Forecasted",
 *       contactEmails: ["ops@example.com"],
 *     },
 *   },
 * });
 * ```
 *
 * ### Filtering Tracked Cost
 * **Example:** Only count resources tagged `env=prod`
 * ```typescript
 * yield* Azure.CostManagement.Budget("prod", {
 *   amount: 500,
 *   startDate: "2026-10-01",
 *   filter: { tags: { name: "env", operator: "In", values: ["prod"] } },
 *   notifications: {
 *     actual90: {
 *       enabled: true,
 *       operator: "GreaterThanOrEqualTo",
 *       threshold: 90,
 *       contactEmails: ["ops@example.com"],
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Budget = Resource<Budget>("Azure.CostManagement.Budget");

/** Generated names end in a 16-character instance suffix (24 with the truncation hash). */
const GENERATED = /-[a-z0-9]{16,}$/i;

const physicalName = (id: string, instanceId?: string) =>
  createPhysicalName({ id, instanceId, maxLength: 63 });

const normalizeScope = (scope: string) =>
  `/${scope.replace(/^\/+|\/+$/g, "")}`;

const sameScope = (a: string, b: string) =>
  normalizeScope(a).toLowerCase() === normalizeScope(b).toLowerCase();

const day = (date: string | undefined) => date?.slice(0, 10);

const getBudget = (scope: string, budgetName: string) =>
  orUndefinedIfNotFound(cm.GetBudget({ scope, budgetName }));

const toAttrs = (
  scope: string,
  budgetName: string,
  budget: cm.GetBudgetResponse,
): Budget["Attributes"] => ({
  budgetName: budget.name ?? budgetName,
  budgetId:
    budget.id ??
    `${normalizeScope(scope)}/providers/Microsoft.CostManagement/budgets/${budgetName}`,
  scope: normalizeScope(scope),
  amount: budget.properties?.amount ?? 0,
  timeGrain: budget.properties?.timeGrain ?? "",
  startDate: day(budget.properties?.timePeriod.startDate) ?? "",
  endDate: day(budget.properties?.timePeriod.endDate),
});

/**
 * Whether every field set in `desired` equals the observed value. Azure
 * echoes server-side defaults (locale, thresholdType, empty lists), so a
 * plain equality check would always report drift.
 */
const covers = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined || desired === null) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((value, i) => covers(value, observed[i]))
    );
  }
  if (typeof desired === "object") {
    if (typeof observed !== "object" || observed === null) return false;
    return Object.entries(desired).every(([key, value]) =>
      covers(value, (observed as Record<string, unknown>)[key]),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  return desired === observed;
};

const notificationsMatch = (
  desired: Record<string, BudgetNotification> | undefined,
  observed: Record<string, BudgetNotification | undefined> | undefined,
) => {
  const want = Object.entries(desired ?? {}).map(
    ([key, value]) => [key.toLowerCase(), value] as const,
  );
  const have = new Map(
    Object.entries(observed ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  return (
    want.length === have.size &&
    want.every(([key, value]) => have.has(key) && covers(value, have.get(key)))
  );
};

export const BudgetProvider = () =>
  Provider.succeed(Budget, {
    stables: ["budgetName", "budgetId", "scope", "timeGrain", "startDate"],

    // Subscription-scoped budgets with a generated name. Resource-group
    // budgets go away with their group.
    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const scope = `/subscriptions/${subscriptionId}`;
      const page = yield* cm
        .ListBudgets({ scope })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListBudgets", page)),
        );
      return (page.value ?? []).flatMap((budget) =>
        budget.name !== undefined && GENERATED.test(budget.name)
          ? [toAttrs(scope, budget.name, budget)]
          : [],
      );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined || !isResolved(news)) return undefined;
      const { subscriptionId } = yield* AzureEnvironment.current;
      const scope = news.scope ?? `/subscriptions/${subscriptionId}`;
      if (
        !sameScope(scope, output.scope) ||
        (news.budgetName !== undefined &&
          news.budgetName.toLowerCase() !== output.budgetName.toLowerCase()) ||
        (news.timeGrain ?? "Monthly").toLowerCase() !==
          output.timeGrain.toLowerCase() ||
        day(news.startDate) !== output.startDate
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const scope =
        output?.scope ?? olds?.scope ?? `/subscriptions/${subscriptionId}`;
      const generated = yield* physicalName(id, instanceId);
      const name = output?.budgetName ?? olds?.budgetName ?? generated;
      const observed = yield* getBudget(scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, observed);
      // No tags: a budget is ours when it carries the name we generated or
      // the name recorded in state.
      return output !== undefined ||
        name.toLowerCase() === generated.toLowerCase()
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.CostManagement");
      const scope = normalizeScope(
        news.scope ?? `/subscriptions/${subscriptionId}`,
      );
      const name =
        news.budgetName ?? output?.budgetName ?? (yield* physicalName(id));
      const timeGrain = news.timeGrain ?? "Monthly";

      // Observe.
      const observed = yield* getBudget(scope, name);
      const current = observed?.properties;

      // Ensure + sync: the PUT is an upsert of the whole budget. Skip it
      // when the observed budget already matches; pass the observed eTag so
      // an update does not overwrite a concurrent change.
      const inSync =
        current !== undefined &&
        current.category === "Cost" &&
        current.amount === news.amount &&
        current.timeGrain.toLowerCase() === timeGrain.toLowerCase() &&
        day(current.timePeriod.startDate) === day(news.startDate) &&
        (news.endDate === undefined ||
          day(current.timePeriod.endDate) === day(news.endDate)) &&
        (news.filter === undefined
          ? current.filter === undefined ||
            Object.values(current.filter).every(
              (value) => value === undefined || value === null,
            )
          : covers(news.filter, current.filter)) &&
        notificationsMatch(news.notifications, current.notifications);

      if (!inSync) {
        yield* cm.BudgetsCreateOrUpdate({
          scope,
          budgetName: name,
          eTag: observed?.eTag,
          properties: {
            category: "Cost",
            amount: news.amount,
            timeGrain,
            timePeriod: {
              startDate: news.startDate,
              endDate: news.endDate ?? current?.timePeriod.endDate,
            },
            filter: news.filter,
            notifications: news.notifications,
          },
        });
      }

      // Budgets have no provisioning state; wait until readable.
      const fresh = yield* waitForProvisioned(
        `budget ${name}`,
        getBudget(scope, name),
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(scope, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        cm.DeleteBudget({ scope: output.scope, budgetName: output.budgetName }),
      );
      yield* waitUntilGone(
        `budget ${output.budgetName}`,
        getBudget(output.scope, output.budgetName),
        { interval: "2 seconds", times: 15 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
