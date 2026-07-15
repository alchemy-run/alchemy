import * as budgets from "@distilled.cloud/aws/budgets";
import * as Layer from "effect/Layer";
import { makeBudgetActionHttpBinding } from "./BindingHttp.ts";
import { DescribeBudgetActionHistories } from "./DescribeBudgetActionHistories.ts";

export const DescribeBudgetActionHistoriesHttp = Layer.effect(
  DescribeBudgetActionHistories,
  makeBudgetActionHttpBinding<
    budgets.DescribeBudgetActionHistoriesRequest,
    budgets.DescribeBudgetActionHistoriesResponse,
    budgets.DescribeBudgetActionHistoriesError
  >({
    tag: "AWS.Budgets.DescribeBudgetActionHistories",
    actions: ["budgets:DescribeBudgetActionHistories"],
    operation: budgets.describeBudgetActionHistories,
  }),
);
