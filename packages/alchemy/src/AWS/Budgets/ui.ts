import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Budget } from "./Budget.ts";
import type { BudgetAction } from "./BudgetAction.ts";

/**
 * Dashboard UI providers for AWS Budgets resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const BudgetUI = UIProvider.succeed<Budget>("AWS.Budgets.Budget", {
  displayName: "Budget",
  icon: "dollar-sign",
  color: "#E7157B",
  category: "billing",
  summary: (ctx) => ctx.attrs?.budgetName,
  facts: (ctx) => [
    { label: "budget", value: ctx.attrs?.budgetName, copy: true },
    { label: "arn", value: ctx.attrs?.budgetArn, mono: true, copy: true },
    { label: "account", value: ctx.attrs?.accountId, mono: true },
    { label: "type", value: ctx.props?.budgetType },
    { label: "time unit", value: ctx.props?.timeUnit },
    {
      label: "limit",
      value: ctx.props?.budgetLimit
        ? `${ctx.props.budgetLimit.amount} ${ctx.props.budgetLimit.unit}`
        : undefined,
    },
  ],
});

export const BudgetActionUI = UIProvider.succeed<BudgetAction>(
  "AWS.Budgets.BudgetAction",
  {
    displayName: "Budget Action",
    icon: "zap",
    color: "#E7157B",
    category: "billing",
    summary: (ctx) => ctx.attrs?.actionId,
    facts: (ctx) => [
      {
        label: "action id",
        value: ctx.attrs?.actionId,
        mono: true,
        copy: true,
      },
      { label: "arn", value: ctx.attrs?.actionArn, mono: true, copy: true },
      { label: "budget", value: ctx.attrs?.budgetName, copy: true },
      { label: "account", value: ctx.attrs?.accountId, mono: true },
      { label: "action type", value: ctx.props?.actionType },
      { label: "approval", value: ctx.props?.approvalModel },
    ],
  },
);

export const ui = () => Layer.mergeAll(BudgetUI, BudgetActionUI);
