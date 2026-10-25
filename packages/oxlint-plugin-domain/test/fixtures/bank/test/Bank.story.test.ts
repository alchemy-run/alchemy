import { Story } from "@alchemy.run/domain/Story";
import { NotOpen } from "../src/Account/NotOpen.rejection.ts";
import { OpenAccount } from "../src/Account/OpenAccount.command.ts";
import { MoneyWithdrawn } from "../src/Account/WithdrawMoney.command.ts";
import { FraudCheck, ScoreUnavailable } from "../src/Fraud/FraudCheck.external.ts";
import { Payments, RefundDeclined } from "../src/Settlement/Payments.external.ts";

const { call, failed, succeed } = Story;

export const story = Story.make(Bank, { layer: BankHandlers, stub: [Payments] });

// Sends OpenAccount, shows WithdrawMoney through its event, asserts NotOpen.
export const steps = [
  Story.when(a1, new OpenAccount({ owner: "sam" })),
  Story.then(a1, new MoneyWithdrawn({ amount: 1 })),
  Story.rejected(new NotOpen()),
];

// A stubbed system answered with its declared error, and a real call that failed.
const unavailable = new ScoreUnavailable();
export const external = [
  Story.call(Payments.refund, { settlementId: "st_1" }),
  Story.fail(Payments.refund, new RefundDeclined({ reason: "card-closed" })),
  call("s-1", FraudCheck.score, { accountId: "a-1" }),
  failed("s-1", FraudCheck.score, unavailable),
  call(Payments.charge, { amount: 1 }),
  succeed(Payments.charge, { chargeId: "ch_1" }),
];
