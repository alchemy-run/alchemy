import * as Domain from "@alchemy.run/domain";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * A small bank whose commands span aggregates: transfers between two
 * accounts, and registrations that claim a unique username. Shared by the
 * decision suites, which host it on each platform.
 */

export const AccountId = Schema.String.pipe(Schema.brand("AccountId"));
export const CustomerId = Schema.String.pipe(Schema.brand("CustomerId"));
export const Username = Schema.String.pipe(Schema.brand("Username"));

export class Deposited extends Domain.Event("Deposited", { amount: Schema.Int }) {}
export class TransferSent extends Domain.Event("TransferSent", {
  to: AccountId,
  amount: Schema.Int,
}) {}
export class TransferReceived extends Domain.Event("TransferReceived", {
  from: AccountId,
  amount: Schema.Int,
}) {}

export class InsufficientFunds extends Domain.Rejection("InsufficientFunds", {
  balance: Schema.Int,
}) {}
export class NotOwner extends Domain.Rejection("NotOwner") {}

/** Who is sending: provided by the caller, read by an effectful `decide`. */
export class CurrentActor extends Context.Service<CurrentActor, { readonly accountId: string }>()(
  "test/Decision/CurrentActor",
) {}

/** A command one aggregate implements, next to the ones decisions implement. */
export class Deposit extends Domain.Command("Deposit", {
  input: { accountId: AccountId, amount: Schema.Int },
  events: [Deposited],
}) {}

export class TransferMoney extends Domain.Command("TransferMoney", {
  input: { from: AccountId, to: AccountId, amount: Schema.Int },
  events: [TransferSent, TransferReceived],
  rejects: [InsufficientFunds],
  reply: { balance: Schema.Int },
}) {}

export class Account extends Domain.Aggregate("Account", {
  id: AccountId,
  state: Schema.Struct({ balance: Schema.Int }),
  initial: { balance: 0 },
  commands: [Deposit],
  keyOf: (command) => command.accountId,
  events: [TransferSent, TransferReceived],
  decide: {
    Deposit: (_, cmd) => [new Deposited({ amount: cmd.amount })],
  },
  evolve: {
    Deposited: (account, e) => ({ balance: account.balance + e.amount }),
    TransferSent: (account, e) => ({ balance: account.balance - e.amount }),
    TransferReceived: (account, e) => ({ balance: account.balance + e.amount }),
  },
}) {}

export class Transfer extends Domain.Decision(TransferMoney, {
  reads: (cmd) => ({ from: Account.ref(cmd.from), to: Account.ref(cmd.to) }),
  decide: ({ from, to }, cmd) =>
    cmd.amount > from.state.balance
      ? new InsufficientFunds({ balance: from.state.balance })
      : [
          from.record(new TransferSent({ to: to.id, amount: cmd.amount })),
          to.record(new TransferReceived({ from: from.id, amount: cmd.amount })),
        ],
  reply: ({ from }) => ({ balance: from.balance }),
}) {}

// ---------------------------------------------------------------- unique usernames

export class CustomerRegistered extends Domain.Event("CustomerRegistered", {
  name: Schema.String,
  username: Username,
}) {}
export class UsernameClaimed extends Domain.Event("UsernameClaimed", {
  customerId: CustomerId,
}) {}

export class AlreadyRegistered extends Domain.Rejection("AlreadyRegistered") {}
export class UsernameTaken extends Domain.Rejection("UsernameTaken") {}

export class RegisterCustomer extends Domain.Command("RegisterCustomer", {
  input: { customerId: CustomerId, name: Schema.String, username: Username },
  events: [CustomerRegistered, UsernameClaimed],
  rejects: [AlreadyRegistered, UsernameTaken],
}) {}

/** An aggregate that only folds: decisions record on it. */
export class Customer extends Domain.Aggregate("Customer", {
  id: CustomerId,
  state: Schema.Union([
    Schema.TaggedStruct("New", {}),
    Schema.TaggedStruct("Registered", { name: Schema.String, username: Username }),
  ]),
  initial: { _tag: "New" },
  events: [CustomerRegistered],
  evolve: {
    CustomerRegistered: (_, e) => ({
      _tag: "Registered" as const,
      name: e.name,
      username: e.username,
    }),
  },
}) {}

export class UsernameClaim extends Domain.Aggregate("UsernameClaim", {
  id: Username,
  state: Schema.Union([
    Schema.TaggedStruct("Free", {}),
    Schema.TaggedStruct("Claimed", { customerId: CustomerId }),
  ]),
  initial: { _tag: "Free" },
  events: [UsernameClaimed],
  evolve: {
    UsernameClaimed: (_, e) => ({ _tag: "Claimed" as const, customerId: e.customerId }),
  },
}) {}

export class Registration extends Domain.Decision(RegisterCustomer, {
  reads: (cmd) => ({
    customer: Customer.ref(cmd.customerId),
    claim: UsernameClaim.ref(cmd.username),
  }),
  decide: ({ customer, claim }, cmd) =>
    customer.state._tag === "Registered"
      ? new AlreadyRegistered()
      : claim.state._tag === "Claimed"
        ? new UsernameTaken()
        : [
            customer.record(new CustomerRegistered({ name: cmd.name, username: cmd.username })),
            claim.record(new UsernameClaimed({ customerId: cmd.customerId })),
          ],
}) {}

// ---------------------------------------------------------------- an effectful decide

export class Refunded extends Domain.Event("Refunded", { amount: Schema.Int }) {}

export class RefundMoney extends Domain.Command("RefundMoney", {
  input: { from: AccountId, to: AccountId, amount: Schema.Int },
  events: [TransferSent, TransferReceived],
  rejects: [NotOwner],
}) {}

/** `decide` as an `Effect.fn`: it reads who is sending, and fails with a rejection. */
export class Refund extends Domain.Decision(RefundMoney, {
  reads: (cmd) => ({ from: Account.ref(cmd.from), to: Account.ref(cmd.to) }),
  decide: Effect.fn(function* ({ from, to }, cmd) {
    const actor = yield* Effect.serviceOption(CurrentActor);
    if (actor._tag === "None" || actor.value.accountId !== from.id) return yield* new NotOwner();
    return [
      from.record(new TransferSent({ to: to.id, amount: cmd.amount })),
      to.record(new TransferReceived({ from: from.id, amount: cmd.amount })),
    ];
  }),
}) {}

// ---------------------------------------------------------------- what follows the events

/** Folds what decisions record, like any other event. */
export class Balance extends Domain.View("Balance", {
  from: [Account],
  key: Account,
  state: Schema.Struct({ balance: Schema.Int, transfers: Schema.Int }),
  initial: { balance: 0, transfers: 0 },
  evolve: {
    Deposited: (s, e) => ({ ...s, balance: s.balance + e.amount }),
    TransferSent: (s, e) => ({ balance: s.balance - e.amount, transfers: s.transfers + 1 }),
    TransferReceived: (s, e) => ({ balance: s.balance + e.amount, transfers: s.transfers + 1 }),
  },
}) {}

export class Bank extends Domain.Model("DecisionBank", {
  aggregates: [Account, Customer, UsernameClaim],
  decisions: [Transfer, Registration, Refund],
  views: [Balance],
}) {}
