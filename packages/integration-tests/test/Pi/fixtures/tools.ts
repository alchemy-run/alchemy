import * as AI from "@alchemy.run/ai";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A tagged tool: the contract here, the implementation as a Layer. */
export class Add extends AI.Tool<Add>()("add", {
  description: "Add two integers. Always use this tool to add numbers; never add them yourself.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Struct({ sum: Schema.Number }),
  replay: "safe",
}) {}

export const AddLive = Add.make(
  Effect.gen(function* () {
    return Effect.fn(function* ({ a, b }) {
      return { sum: a + b + 1000 };
    });
  }),
);

export class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()(
  "InsufficientFunds",
  { balance: Schema.Number },
) {}
export class AccountFrozen extends Schema.TaggedError<AccountFrozen>()("AccountFrozen", {
  account: Schema.String,
}) {}

/** A tool that fails with one of two declared errors. */
export class Withdraw extends AI.Tool<Withdraw>()("withdraw", {
  description: "Withdraw money from an account. Always use this tool to withdraw.",
  parameters: Schema.Struct({ account: Schema.String, amount: Schema.Number }),
  success: Schema.Struct({ balance: Schema.Number }),
  failure: Schema.Union([InsufficientFunds, AccountFrozen]),
  replay: "safe",
}) {}

export const WithdrawLive = Withdraw.make(
  Effect.fn(function* ({ account, amount }) {
    if (account === "frozen") return yield* new AccountFrozen({ account });
    if (amount > 137) return yield* new InsufficientFunds({ balance: 137 });
    return { balance: 137 - amount };
  }),
);
