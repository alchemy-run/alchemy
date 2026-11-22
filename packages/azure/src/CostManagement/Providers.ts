import * as Layer from "effect/Layer";
import { Budget, BudgetProvider } from "./Budget.ts";

export const resources = [Budget];
export const layers = () => Layer.mergeAll(BudgetProvider());
