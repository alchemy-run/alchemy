import { Rejection } from "alchemy/Fold";
import { Cents } from "../Money.ts";

/** The balance does not cover the amount. */
export class InsufficientFunds extends Rejection.make("InsufficientFunds", {
  data: { balance: Cents, requested: Cents },
}) {}
