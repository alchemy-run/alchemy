import * as Domain from "@alchemy.run/domain";
import * as BigDecimal from "effect/BigDecimal";
import * as Schema from "effect/Schema";

const Amount = Schema.BigDecimal.check(
  Schema.isGreaterThanBigDecimal(BigDecimal.fromNumberUnsafe(0)),
);

export class Charged extends Domain.Event("Charged", { amount: Schema.BigDecimal }) {}

export class Refunded extends Domain.Event("Refunded", { amount: Schema.BigDecimal }) {}

export class Waived extends Domain.Event("Waived", { amount: Schema.BigDecimal }) {}

export class NothingToRefund extends Domain.Rejection("NothingToRefund", {}) {}

export class Charge extends Domain.Command("Charge", {
  input: { id: Schema.String, amount: Amount },
  events: [Charged],
}) {}

export class Refund extends Domain.Command("Refund", {
  input: { id: Schema.String, amount: Amount },
  events: [Refunded],
  rejects: [NothingToRefund],
}) {}

export class Waive extends Domain.Command("Waive", {
  input: { id: Schema.String, amount: Amount },
  events: [Waived],
}) {}

/** A fee of a tenth of a charge: what a decimal counts exactly and a `number` does not. */
const FEE = BigDecimal.fromStringUnsafe("0.1");

/**
 * What a customer was charged and refunded, in decimals. A refund is never
 * more than what is left of the charges; a waiver takes its amount off the
 * refunds without looking, which breaks that.
 */
export class Ledger extends Domain.Aggregate("Ledger", {
  id: Schema.String,
  state: Schema.Struct({
    charged: Schema.BigDecimal,
    refunded: Schema.BigDecimal,
    fees: Schema.BigDecimal,
  }),
  initial: {
    charged: BigDecimal.fromNumberUnsafe(0),
    refunded: BigDecimal.fromNumberUnsafe(0),
    fees: BigDecimal.fromNumberUnsafe(0),
  },
  invariants: {
    NeverRefundedMoreThanCharged: (ledger) =>
      BigDecimal.isLessThanOrEqualTo(ledger.refunded, ledger.charged),
    NothingRefundedBelowZero: (ledger) => !BigDecimal.isNegative(ledger.refunded),
    TheFeesAreATenthOfTheCharges: (ledger) =>
      BigDecimal.equals(ledger.fees, BigDecimal.multiply(ledger.charged, FEE)),
  },
  commands: [Charge, Refund, Waive],
  keyOf: (command) => command.id,
  decide: {
    Charge: (_ledger, command) => [new Charged({ amount: command.amount })],
    // No more than what is left of the charges is refunded.
    Refund: (ledger, command) => {
      const left = BigDecimal.subtract(ledger.charged, ledger.refunded);
      const amount = BigDecimal.min(command.amount, left);
      return BigDecimal.isPositive(amount) ? [new Refunded({ amount })] : new NothingToRefund();
    },
    Waive: (_ledger, command) => [new Waived({ amount: command.amount })],
  },
  evolve: {
    Charged: (ledger, event) => ({
      ...ledger,
      charged: BigDecimal.sum(ledger.charged, event.amount),
      fees: ledger.fees.pipe(BigDecimal.sum(BigDecimal.multiply(event.amount, FEE))),
    }),
    Refunded: (ledger, event) => ({
      ...ledger,
      refunded: BigDecimal.sum(ledger.refunded, event.amount),
    }),
    Waived: (ledger, event) => ({
      ...ledger,
      refunded: BigDecimal.subtract(ledger.refunded, event.amount),
    }),
  },
}) {}
