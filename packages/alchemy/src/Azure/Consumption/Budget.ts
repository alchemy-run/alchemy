import * as consumption from "@distilled.cloud/azure/consumption";
import * as resources from "@distilled.cloud/azure/resources";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Output from "../../Output.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  stackAndStage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export type BudgetTimeGrain = consumption.TimeGrainType;
export type BudgetFilter = consumption.BudgetFilter;
export type BudgetComparisonExpression = consumption.BudgetComparisonExpression;

/** An alert sent when spend crosses a percentage of the budget amount. */
export interface BudgetNotification {
  /**
   * Whether the alert is active.
   * @default true
   */
  enabled?: boolean;
  /** How spend is compared with the threshold. */
  operator: "EqualTo" | "GreaterThan" | "GreaterThanOrEqualTo";
  /** Threshold as a percentage of the budget amount (0-1000). */
  threshold: number;
  /**
   * Email addresses to alert. At subscription and resource-group scope at
   * least one email or action group is required.
   */
  contactEmails: string[];
  /** RBAC roles to alert, e.g. `Owner` or `Contributor`. */
  contactRoles?: string[];
  /**
   * ARM IDs of Azure Monitor action groups to trigger. Only supported at
   * subscription and resource-group scope.
   */
  contactGroups?: string[];
  /**
   * Whether the threshold applies to actual or forecasted spend.
   * @default "Actual"
   */
  thresholdType?: "Actual" | "Forecasted";
  /** Language of the alert email, e.g. `en-us`. */
  locale?: string;
}

export interface BudgetProps {
  /**
   * ARM ID of the scope the budget tracks — a subscription
   * (`/subscriptions/{id}`) or a resource group (`group.resourceGroupId`).
   * Changing it replaces the budget.
   * @default the current subscription
   */
  scope?: string;
  /**
   * Budget name, 1-63 letters, digits, `-` and `_`. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the budget.
   */
  name?: string;
  /** Spend limit tracked per time grain, in the billing currency. */
  amount: number;
  /**
   * Period after which tracked spend resets. Changing it replaces the
   * budget. `BillingMonth`, `BillingQuarter` and `BillingAnnual` are only
   * available to Web Direct customers.
   * @default "Monthly"
   */
  timeGrain?: BudgetTimeGrain;
  /**
   * First day of the budget (`YYYY-MM-DD`), the first of a month. Changing
   * it replaces the budget.
   * @default the first day of the month the budget is created in
   */
  startDate?: string;
  /**
   * Last day of the budget (`YYYY-MM-DD`).
   * @default ten years after the start date
   */
  endDate?: string;
  /**
   * Restricts the tracked spend to resource groups, resources, meters, or
   * tags.
   */
  filter?: BudgetFilter;
  /**
   * Alerts keyed by a name of your choice; at most five.
   */
  notifications?: Record<string, BudgetNotification>;
}

export interface Budget extends Resource<
  "Azure.Consumption.Budget",
  BudgetProps,
  {
    /** Budget name. */
    budgetName: string;
    /** ARM resource ID of the budget. */
    budgetId: string;
    /** ARM ID of the scope the budget tracks. */
    scope: string;
    /** Spend limit per time grain. */
    amount: number;
    /** Period after which tracked spend resets. */
    timeGrain: string;
    /** Start of the budget, as returned by Azure (ISO 8601). */
    startDate: string;
    /** End of the budget, as returned by Azure (ISO 8601). */
    endDate: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Cost Management budget — tracks spend at a subscription or resource
 * group scope and emails (or triggers action groups) when actual or
 * forecasted spend crosses a threshold. Budgets only alert; they never stop
 * resources.
 *
 * Budgets cannot be tagged. Alchemy treats a budget as owned when its name
 * is the one Alchemy generated for this stack, stage and logical ID, or
 * when it lives in a resource group carrying this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/cost-management-billing/costs/tutorial-acm-create-budgets
 *
 * ### Subscription Budget
 * **Example:** Alert at 80% of a monthly $50 budget
 * ```typescript
 * yield* Azure.Consumption.Budget("monthly", {
 *   amount: 50,
 *   notifications: {
 *     actual80: {
 *       operator: "GreaterThan",
 *       threshold: 80,
 *       contactEmails: ["billing@example.com"],
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** Alert on forecasted spend
 * ```typescript
 * yield* Azure.Consumption.Budget("forecast", {
 *   amount: 200,
 *   notifications: {
 *     forecast100: {
 *       operator: "GreaterThanOrEqualTo",
 *       threshold: 100,
 *       thresholdType: "Forecasted",
 *       contactEmails: ["billing@example.com"],
 *       contactRoles: ["Owner"],
 *     },
 *   },
 * });
 * ```
 *
 * ### Resource Group Budget
 * **Example:** Budget for one resource group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * yield* Azure.Consumption.Budget("app-budget", {
 *   scope: group.resourceGroupId,
 *   amount: 20,
 *   timeGrain: "Quarterly",
 *   notifications: {
 *     actual90: {
 *       operator: "GreaterThan",
 *       threshold: 90,
 *       contactEmails: ["team@example.com"],
 *     },
 *   },
 * });
 * ```
 *
 * ### Filtered Budget
 * **Example:** Track only resources tagged `env=prod`
 * ```typescript
 * yield* Azure.Consumption.Budget("prod", {
 *   amount: 500,
 *   filter: {
 *     tags: { name: "env", operator: "In", values: ["prod"] },
 *   },
 *   notifications: {
 *     actual100: {
 *       operator: "GreaterThan",
 *       threshold: 100,
 *       contactEmails: ["billing@example.com"],
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Budget = Resource<Budget>("Azure.Consumption.Budget");

type ObservedBudget = consumption.GetBudgetResponse;

const budgetName = (id: string, instanceId?: string) =>
  createPhysicalName({ id, instanceId, maxLength: 63 });

/** Alchemy-generated names end in a 16-character base32 instance suffix. */
const GENERATED_NAME = /-[a-z2-7]{16}$/;

const normalizeScope = (scope: string) => `/${scope.replace(/^\/+|\/+$/g, "")}`;

const sameScope = (a: string, b: string) =>
  normalizeScope(a).toLowerCase() === normalizeScope(b).toLowerCase();

const subscriptionScope = (subscriptionId: string) =>
  `/subscriptions/${subscriptionId}`;

const resourceGroupScope = (scope: string) =>
  normalizeScope(scope).match(
    /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)$/i,
  );

/** `YYYY-MM-DD` part of a date or ISO timestamp. */
const dateOf = (value: string | undefined) => value?.slice(0, 10);

const firstOfMonth = Effect.sync(() => {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
});

const getBudget = (scope: string, name: string) =>
  orUndefinedIfNotFound(consumption.GetBudget({ scope, budgetName: name }));

const toAttrs = (
  scope: string,
  name: string,
  budget: ObservedBudget,
): Budget["Attributes"] => ({
  budgetName: name,
  budgetId:
    budget.id ??
    `${normalizeScope(scope)}/providers/Microsoft.Consumption/budgets/${name}`,
  scope: normalizeScope(scope),
  amount: budget.properties?.amount ?? 0,
  timeGrain: budget.properties?.timeGrain ?? "",
  startDate: budget.properties?.timePeriod.startDate ?? "",
  endDate: budget.properties?.timePeriod.endDate,
});

/** Canonical JSON (sorted keys, empty values dropped) for comparisons. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, x]) => x !== undefined && x !== null)
          .sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return v;
  });

const isEmptyFilter = (filter: BudgetFilter | undefined) =>
  filter === undefined ||
  (filter.and === undefined &&
    filter.dimensions === undefined &&
    filter.tags === undefined);

const toNotification = (n: BudgetNotification): consumption.Notification => ({
  enabled: n.enabled ?? true,
  operator: n.operator,
  threshold: n.threshold,
  contactEmails: n.contactEmails,
  contactRoles: n.contactRoles ?? [],
  contactGroups: n.contactGroups ?? [],
  thresholdType: n.thresholdType ?? "Actual",
  locale: n.locale,
});

/** Whether the observed notifications already match the desired ones. */
const sameNotifications = (
  observed: consumption.BudgetPropertiesNotificationsMap | undefined,
  desired: Record<string, consumption.Notification>,
) => {
  const observedKeys = Object.keys(observed ?? {})
    .map((k) => k.toLowerCase())
    .sort();
  const desiredKeys = Object.keys(desired)
    .map((k) => k.toLowerCase())
    .sort();
  if (canonical(observedKeys) !== canonical(desiredKeys)) return false;
  const observedByKey = new Map(
    Object.entries(observed ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return Object.entries(desired).every(([key, want]) => {
    const have = observedByKey.get(key.toLowerCase());
    if (have === undefined) return false;
    const comparable = (n: consumption.Notification, locale: boolean) => ({
      enabled: n.enabled,
      operator: n.operator,
      threshold: n.threshold,
      contactEmails: [...n.contactEmails].sort(),
      contactRoles: [...(n.contactRoles ?? [])].sort(),
      contactGroups: [...(n.contactGroups ?? [])]
        .map((g) => g.toLowerCase())
        .sort(),
      thresholdType: n.thresholdType ?? "Actual",
      locale: locale ? n.locale?.toLowerCase() : undefined,
    });
    // An unset locale accepts whatever Azure defaults to.
    const checkLocale = want.locale !== undefined;
    return (
      canonical(comparable(have, checkLocale)) ===
      canonical(comparable(want, checkLocale))
    );
  });
};

/** The resource group in `scope` carries this stack's and stage's tags. */
const resourceGroupOwned = (scope: string) =>
  Effect.gen(function* () {
    const match = resourceGroupScope(scope);
    if (match === null) return false;
    const group = yield* orUndefinedIfNotFound(
      resources.GetResourceGroup({
        subscriptionId: match[1]!,
        resourceGroupName: match[2]!,
      }),
    );
    const { stack, stage } = yield* stackAndStage;
    return (
      group?.tags?.["alchemy::stack"] === stack &&
      group?.tags?.["alchemy::stage"] === stage
    );
  });

export const BudgetProvider = () =>
  Provider.succeed(Budget, {
    stables: ["budgetName", "budgetId", "scope", "timeGrain", "startDate"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const listAt = (scope: string) =>
        orUndefinedIfNotFound(
          consumption
            .ListBudgets({ scope })
            .pipe(
              Effect.flatMap((page) => requireSinglePage("ListBudgets", page)),
            ),
        ).pipe(
          Effect.map((page) =>
            (page?.value ?? []).flatMap((budget) =>
              budget.name !== undefined
                ? [{ scope, name: budget.name, budget }]
                : [],
            ),
          ),
        );
      // Subscription-scope budgets carry no ownership marker; only the
      // Alchemy-generated name shape identifies them.
      const subscriptionBudgets = (yield* listAt(
        subscriptionScope(subscriptionId),
      )).filter(({ name }) => GENERATED_NAME.test(name));
      const groups = yield* resources
        .ListResourceGroups({
          subscriptionId,
          _filter: "tagName eq 'alchemy::stack'",
        })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListResourceGroups", page),
          ),
        );
      const groupBudgets = yield* Effect.forEach(
        (groups.value ?? []).filter(
          (group) => hasAnyAlchemyTag(group.tags) && group.name !== undefined,
        ),
        (group) =>
          listAt(
            `${subscriptionScope(subscriptionId)}/resourceGroups/${group.name}`,
          ),
        { concurrency: 4 },
      );
      return [...subscriptionBudgets, ...groupBudgets.flat()].map(
        ({ scope, name, budget }) => toAttrs(scope, name, budget),
      );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // The whole props object may be one unresolved expression.
      const fields =
        Output.isOutput(news) || Effect.isEffect(news) || Config.isConfig(news)
          ? undefined
          : news;
      if (fields === undefined) return undefined;
      // An unresolved scope means its resource group is being replaced.
      if (fields.scope !== undefined && !isResolved(fields.scope)) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      const { subscriptionId } = yield* AzureEnvironment.current;
      const scope = news.scope ?? subscriptionScope(subscriptionId);
      const name = news.name ?? output.budgetName;
      if (
        !sameScope(scope, output.scope) ||
        name !== output.budgetName ||
        (news.timeGrain ?? "Monthly").toLowerCase() !==
          output.timeGrain.toLowerCase() ||
        (news.startDate !== undefined &&
          dateOf(news.startDate) !== dateOf(output.startDate))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const scope =
        output?.scope ?? olds?.scope ?? subscriptionScope(subscriptionId);
      const generated = yield* budgetName(id, instanceId);
      const name = output?.budgetName ?? olds?.name ?? generated;
      const observed = yield* getBudget(scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, observed);
      return name === generated || (yield* resourceGroupOwned(scope))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Consumption");
      const scope = normalizeScope(
        news.scope ?? subscriptionScope(subscriptionId),
      );
      const name =
        news.name ?? output?.budgetName ?? (yield* budgetName(id, instanceId));

      // Observe.
      const observed = yield* getBudget(scope, name);
      const current = observed?.properties;

      // Desired state. An omitted start date keeps the observed one so the
      // budget does not drift as months pass.
      const startDate =
        news.startDate !== undefined
          ? `${dateOf(news.startDate)}T00:00:00Z`
          : (current?.timePeriod.startDate ??
            `${yield* firstOfMonth}T00:00:00Z`);
      const endDate =
        news.endDate !== undefined
          ? `${dateOf(news.endDate)}T00:00:00Z`
          : current?.timePeriod.endDate;
      const notifications = Object.fromEntries(
        Object.entries(news.notifications ?? {}).map(([key, n]) => [
          key,
          toNotification(n),
        ]),
      );
      const desired: consumption.BudgetPropertiesInput = {
        category: "Cost",
        amount: news.amount,
        timeGrain: news.timeGrain ?? "Monthly",
        timePeriod: { startDate, endDate },
        filter: news.filter,
        notifications,
      };

      // Ensure + sync: the PUT is a synchronous full-body upsert; skip it
      // when the observed budget already matches.
      const inSync =
        current !== undefined &&
        current.amount === desired.amount &&
        current.timeGrain.toLowerCase() === desired.timeGrain.toLowerCase() &&
        dateOf(current.timePeriod.startDate) === dateOf(startDate) &&
        (endDate === undefined ||
          dateOf(current.timePeriod.endDate) === dateOf(endDate)) &&
        (isEmptyFilter(current.filter) && isEmptyFilter(news.filter)
          ? true
          : canonical(current.filter) === canonical(news.filter)) &&
        sameNotifications(current.notifications, notifications);
      if (!inSync) {
        yield* consumption.BudgetsCreateOrUpdate({
          scope,
          budgetName: name,
          properties: desired,
          eTag: observed?.eTag,
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
        consumption.DeleteBudget({
          scope: output.scope,
          budgetName: output.budgetName,
        }),
      );
      yield* waitUntilGone(
        `budget ${output.budgetName}`,
        getBudget(output.scope, output.budgetName),
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
