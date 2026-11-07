<!-- Docs for the generated AWS.Budgets bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## DescribeBudget

Runtime binding for `budgets:ViewBudget` via `DescribeBudget`.

Bind this operation to a {@link Budget} to read its definition and — most
usefully at runtime — its `CalculatedSpend` (actual and forecasted spend so
far in the period), e.g. for a cost kill-switch or a spend dashboard.
Provide the implementation with
`Effect.provide(AWS.Budgets.DescribeBudgetHttp)`.
### Reading Budget Spend
**Example:** Check Actual Spend Against the Limit
```typescript
// init — bind the operation to the budget
const describeBudget = yield* AWS.Budgets.DescribeBudget(budget);

// runtime
const { Budget: b } = yield* describeBudget();
const actual = Number(b?.CalculatedSpend?.ActualSpend?.Amount ?? "0");
const limit = Number(b?.BudgetLimit?.Amount ?? "0");
const overBudget = limit > 0 && actual >= limit;
```

@binding

## DescribeBudget.Request

Request for {@link DescribeBudget} — the bound budget's `AccountId` and
`BudgetName` are injected automatically.

## DescribeBudgetActionHistories

Runtime binding for `budgets:DescribeBudgetActionHistories`.

Bind this operation to a {@link BudgetAction} to read its event history —
creations, updates, and executions with their statuses — e.g. to audit
when a kill-switch fired and whether it succeeded. Provide the
implementation with
`Effect.provide(AWS.Budgets.DescribeBudgetActionHistoriesHttp)`.
### Reading Budget Actions
**Example:** Read an Action's Event History
```typescript
// init — bind the operation to the action
const histories = yield* AWS.Budgets.DescribeBudgetActionHistories(action);

// runtime
const result = yield* histories({});
const executions = result.ActionHistories.filter(
  (h) => h.EventType === "EXECUTE_ACTION",
);
```

@binding

## DescribeBudgetActionHistories.Request

Request for {@link DescribeBudgetActionHistories} — the bound action's
`AccountId`, `BudgetName`, and `ActionId` are injected automatically.

## DescribeBudgetActionsForBudget

Runtime binding for `budgets:DescribeBudgetActionsForBudget`.

Bind this operation to a {@link Budget} to list its budget actions and
their execution status — e.g. to check whether a cost kill-switch has
fired. Provide the implementation with
`Effect.provide(AWS.Budgets.DescribeBudgetActionsForBudgetHttp)`.
### Reading Budget Actions
**Example:** List a Budget's Actions and Statuses
```typescript
// init — bind the operation to the budget
const listActions = yield* AWS.Budgets.DescribeBudgetActionsForBudget(budget);

// runtime
const result = yield* listActions();
const statuses = (result.Actions ?? []).map((a) => a.Status);
```

@binding

## DescribeBudgetActionsForBudget.Request

Request for {@link DescribeBudgetActionsForBudget} — the bound budget's
`AccountId` and `BudgetName` are injected automatically.

## DescribeBudgetPerformanceHistory

Runtime binding for `budgets:ViewBudget` via
`DescribeBudgetPerformanceHistory`.

Bind this operation to a {@link Budget} to read its budgeted-vs-actual
amounts for past periods — e.g. to render a spend trend or detect
consistently blown budgets. Provide the implementation with
`Effect.provide(AWS.Budgets.DescribeBudgetPerformanceHistoryHttp)`.
### Reading Budget Spend
**Example:** Read Budgeted vs Actual Amounts
```typescript
// init — bind the operation to the budget
const history = yield* AWS.Budgets.DescribeBudgetPerformanceHistory(budget);

// runtime
const result = yield* history();
const periods =
  result.BudgetPerformanceHistory?.BudgetedAndActualAmountsList ?? [];
```

@binding

## DescribeBudgetPerformanceHistory.Request

Request for {@link DescribeBudgetPerformanceHistory} — the bound budget's
`AccountId` and `BudgetName` are injected automatically.

## DescribeNotificationsForBudget

Runtime binding for `budgets:ViewBudget` via
`DescribeNotificationsForBudget`.

Bind this operation to a {@link Budget} to list its alert thresholds and
their alarm state (`NotificationState` is `ALARM` once a threshold has been
crossed) — e.g. to gate expensive work on whether any budget alert has
fired. Provide the implementation with
`Effect.provide(AWS.Budgets.DescribeNotificationsForBudgetHttp)`.
### Reading Budget Alerts
**Example:** Check Whether Any Alert Is in Alarm
```typescript
// init — bind the operation to the budget
const notifications = yield* AWS.Budgets.DescribeNotificationsForBudget(budget);

// runtime
const result = yield* notifications();
const inAlarm = (result.Notifications ?? []).some(
  (n) => n.NotificationState === "ALARM",
);
```

@binding

## DescribeNotificationsForBudget.Request

Request for {@link DescribeNotificationsForBudget} — the bound budget's
`AccountId` and `BudgetName` are injected automatically.

## DescribeSubscribersForNotification

Runtime binding for `budgets:ViewBudget` via
`DescribeSubscribersForNotification`.

Bind this operation to a {@link Budget} to list who is notified when a
given alert threshold is crossed — pair it with
`DescribeNotificationsForBudget` to enumerate a budget's full alerting
fan-out (each subscriber's `Address` comes back `Redacted`). Provide the
implementation with
`Effect.provide(AWS.Budgets.DescribeSubscribersForNotificationHttp)`.
### Reading Budget Alerts
**Example:** List the Recipients of Each Alert
```typescript
// init — bind both operations to the budget
const notifications = yield* AWS.Budgets.DescribeNotificationsForBudget(budget);
const subscribers = yield* AWS.Budgets.DescribeSubscribersForNotification(budget);

// runtime
const { Notifications = [] } = yield* notifications();
for (const notification of Notifications) {
  const result = yield* subscribers({ Notification: notification });
  const recipients = (result.Subscribers ?? []).map((s) => s.SubscriptionType);
}
```

@binding

## DescribeSubscribersForNotification.Request

Request for {@link DescribeSubscribersForNotification} — the bound budget's
`AccountId` and `BudgetName` are injected automatically. `Notification`
identifies which alert threshold to list subscribers for (the same shape
returned by `DescribeNotificationsForBudget`).

## ExecuteBudgetAction

Runtime binding for `budgets:ExecuteBudgetAction`.

Bind this operation to a {@link BudgetAction} to approve, retry, reverse,
or reset it from inside a function runtime — e.g. an approval workflow that
approves a pending kill-switch, or an automated recovery that reverses it
at the start of a new period. Provide the implementation with
`Effect.provide(AWS.Budgets.ExecuteBudgetActionHttp)`.
### Executing Budget Actions
**Example:** Approve a Pending Action
```typescript
// init — bind the operation to the action
const execute = yield* AWS.Budgets.ExecuteBudgetAction(action);

// runtime
yield* execute({ ExecutionType: "APPROVE_BUDGET_ACTION" });
```

**Example:** Reverse an Executed Action
```typescript
yield* execute({ ExecutionType: "REVERSE_BUDGET_ACTION" });
```

@binding

## ExecuteBudgetAction.Request

Request for {@link ExecuteBudgetAction} — the bound action's `AccountId`,
`BudgetName`, and `ActionId` are injected automatically.
