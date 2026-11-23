import * as AI from "@alchemy.run/ai";
import { describe, expect, test } from "@alchemy.run/test";
import * as Schema from "effect/Schema";

class Owner extends Schema.Class<Owner>("Owner")({ name: Schema.String }) {}

class Account extends Schema.Class<Account>("Account")(
  {
    id: Schema.String,
    balance: Schema.Number.annotate({ description: "In cents." }),
    nickname: Schema.optional(Schema.String),
    owner: Schema.NullOr(Owner),
  },
  { description: "A bank account." },
) {}

class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()(
  "InsufficientFunds",
  { balance: Schema.Number.annotate({ description: "What the account holds, in cents." }) },
  { description: "The account holds less than the amount asked for." },
) {}

class AccountFrozen extends Schema.TaggedError<AccountFrozen>()("AccountFrozen", {
  account: Schema.String,
}) {}

const add: AI.DeclaredTool = {
  name: "add",
  description: "Add two integers.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Struct({ sum: Schema.Number }),
};

const withdraw: AI.DeclaredTool = {
  name: "withdraw",
  description: "Withdraw money from an account.",
  parameters: Schema.Struct({ account: Schema.String, amount: Schema.Number }),
  success: Account,
  failure: Schema.Union([InsufficientFunds, AccountFrozen]),
};

const bank: AI.DeclaredNamespace = {
  name: "bank",
  description: "The bank's accounts.",
  tools: [
    {
      name: "close-account",
      description: "Close an account.",
      parameters: Schema.Struct({ id: Schema.String }),
      success: Schema.Void,
      failure: AccountFrozen,
    },
  ],
};

describe("AI.renderDeclarations", { tags: ["unit"] }, () => {
  test("the Effect form returns each tool's failures in its Effect, as classes", () => {
    expect(AI.renderDeclarations("effect", { tools: [add, withdraw], namespaces: [bank] })).toBe(
      `declare namespace tools {
  /** A bank account. */
  interface Account {
    readonly id: string;
    /** In cents. */
    readonly balance: number;
    readonly nickname?: string;
    readonly owner: Owner | null;
  }

  /** The account holds less than the amount asked for. */
  class InsufficientFunds extends Data.TaggedError("InsufficientFunds")<{
    /** What the account holds, in cents. */
    readonly balance: number;
  }> {}

  class AccountFrozen extends Data.TaggedError("AccountFrozen")<{
    readonly account: string;
  }> {}

  interface Owner {
    readonly name: string;
  }

  /** Add two integers. */
  function add(args: { a: number; b: number }): Effect<{ sum: number }>;

  /** Withdraw money from an account. */
  function withdraw(args: { account: string; amount: number }): Effect<Account, InsufficientFunds | AccountFrozen>;

  /** The bank's accounts. */
  namespace bank {
    class AccountFrozen extends Data.TaggedError("AccountFrozen")<{
      readonly account: string;
    }> {}

    /** Close an account. */
    function close_account(args: { id: string }): Effect<void, AccountFrozen>;
  }
}`,
    );
  });

  test("the async form returns a Promise and names each failure it throws", () => {
    expect(AI.renderDeclarations("async", { tools: [withdraw], namespaces: [bank] })).toBe(
      `declare namespace tools {
  /** A bank account. */
  interface Account {
    readonly id: string;
    /** In cents. */
    readonly balance: number;
    readonly nickname?: string;
    readonly owner: Owner | null;
  }

  /** The account holds less than the amount asked for. */
  class InsufficientFunds extends Error {
    readonly _tag: "InsufficientFunds";
    /** What the account holds, in cents. */
    readonly balance: number;
  }

  class AccountFrozen extends Error {
    readonly _tag: "AccountFrozen";
    readonly account: string;
  }

  interface Owner {
    readonly name: string;
  }

  /**
   * Withdraw money from an account.
   * @throws {InsufficientFunds}
   * @throws {AccountFrozen}
   */
  function withdraw(args: { account: string; amount: number }): Promise<Account>;

  /** The bank's accounts. */
  namespace bank {
    class AccountFrozen extends Error {
      readonly _tag: "AccountFrozen";
      readonly account: string;
    }

    /**
     * Close an account.
     * @throws {AccountFrozen}
     */
    function close_account(args: { id: string }): Promise<void>;
  }
}`,
    );
  });

  test("two different schemas with one name in a namespace are refused", () => {
    const other = Schema.Struct({ iban: Schema.String }).annotate({ identifier: "Account" });
    expect(() =>
      AI.renderDeclarations("async", {
        tools: [withdraw, { ...add, name: "lookup", success: other }],
      }),
    ).toThrow(/Two different schemas in `tools` are named `Account`/);
  });
});
