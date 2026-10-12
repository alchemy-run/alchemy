import * as Domain from "alchemy/Domain";
import { Cents } from "../Money.ts";

/** The balance does not cover the amount. */
export class InsufficientFunds extends Domain.Rejection("InsufficientFunds", {
  data: { balance: Cents, requested: Cents },
}) {}
