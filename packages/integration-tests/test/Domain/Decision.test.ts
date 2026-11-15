import * as Domain from "@alchemy.run/domain";
import { InMemory } from "@alchemy.run/domain/InMemory";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  Account,
  AccountId,
  AlreadyRegistered,
  Balance,
  Bank,
  CurrentActor,
  Customer,
  CustomerId,
  CustomerRegistered,
  Deposit,
  InsufficientFunds,
  NotOwner,
  Refund,
  RefundMoney,
  RegisterCustomer,
  Registration,
  Transfer,
  TransferMoney,
  TransferReceived,
  TransferSent,
  Username,
  UsernameClaim,
  UsernameClaimed,
  UsernameTaken,
} from "./decision-model.ts";

const a = AccountId.make("a");
const b = AccountId.make("b");

const hosted = Bank.layer(Layer.empty).pipe(Layer.provide(InMemory));

/** Two accounts, the first with 100. */
const funded = Effect.gen(function* () {
  const accounts = yield* Account;
  yield* accounts.send(new Deposit({ accountId: a, amount: 100 }));
  return accounts;
});

describe("Domain decision", { tags: ["unit", "local"] }, () => {
  it.effect("records on every instance it read, and replies", () =>
    Effect.gen(function* () {
      const accounts = yield* funded;
      const transfer = yield* Transfer;
      const receipt = yield* transfer.send(new TransferMoney({ from: a, to: b, amount: 30 }));
      expect(receipt.reply).toEqual({ balance: 70 });
      expect(receipt.events).toEqual([
        new TransferSent({ to: b, amount: 30 }),
        new TransferReceived({ from: a, amount: 30 }),
      ]);
      expect(receipt.commits).toEqual([
        { stream: "Account/a", version: 2 },
        { stream: "Account/b", version: 1 },
      ]);
      expect(yield* accounts.get(a)).toEqual({ balance: 70 });
      expect(yield* accounts.get(b)).toEqual({ balance: 30 });
    }).pipe(Effect.provide(hosted)),
  );

  it.effect("a rejection records nothing", () =>
    Effect.gen(function* () {
      const accounts = yield* funded;
      const transfer = yield* Transfer;
      const rejection = yield* Effect.flip(
        transfer.send(new TransferMoney({ from: a, to: b, amount: 500 })),
      );
      expect(rejection).toEqual(new InsufficientFunds({ balance: 100 }));
      expect(yield* accounts.get(a)).toEqual({ balance: 100 });
      expect(yield* accounts.get(b)).toEqual({ balance: 0 });
    }).pipe(Effect.provide(hosted)),
  );

  it.effect("a command id already committed returns its first receipt", () =>
    Effect.gen(function* () {
      const accounts = yield* funded;
      const transfer = yield* Transfer;
      const command = new TransferMoney({ from: a, to: b, amount: 30 });
      const first = yield* transfer.send(command, { commandId: "t-1" });
      const again = yield* transfer.send(command, { commandId: "t-1" });
      expect(again).toEqual(first);
      expect(yield* accounts.get(a)).toEqual({ balance: 70 });
    }).pipe(Effect.provide(hosted)),
  );

  it.live("its events reach views like any other", () =>
    Effect.gen(function* () {
      yield* funded;
      const transfer = yield* Transfer;
      const receipt = yield* transfer.send(new TransferMoney({ from: a, to: b, amount: 30 }));
      const balances = yield* Balance;
      expect(yield* balances.get(Account.ref("a"), { atLeast: receipt.commits[0]! })).toEqual(
        Option.some({ balance: 70, transfers: 1 }),
      );
      expect(yield* balances.get(Account.ref("b"), { atLeast: receipt.commits[1]! })).toEqual(
        Option.some({ balance: 30, transfers: 1 }),
      );
    }).pipe(Effect.provide(hosted)),
  );

  it.effect("a transfer to the same account reads it once", () =>
    Effect.gen(function* () {
      const accounts = yield* funded;
      const transfer = yield* Transfer;
      const receipt = yield* transfer.send(new TransferMoney({ from: a, to: a, amount: 30 }));
      expect(receipt.commits).toEqual([{ stream: "Account/a", version: 3 }]);
      expect(yield* accounts.get(a)).toEqual({ balance: 100 });
    }).pipe(Effect.provide(hosted)),
  );

  it.effect("concurrent transfers never overdraw", () =>
    Effect.gen(function* () {
      const accounts = yield* funded;
      const transfer = yield* Transfer;
      const exits = yield* Effect.forEach(
        Array.from({ length: 10 }, (_, i) => i),
        () => Effect.exit(transfer.send(new TransferMoney({ from: a, to: b, amount: 30 }))),
        { concurrency: "unbounded" },
      );
      expect(exits.filter(Exit.isSuccess).length).toBe(3);
      expect(yield* accounts.get(a)).toEqual({ balance: 10 });
      expect(yield* accounts.get(b)).toEqual({ balance: 90 });
    }).pipe(Effect.provide(hosted)),
  );

  it.effect("an effectful decide reads what its sender provides", () =>
    Effect.gen(function* () {
      const accounts = yield* funded;
      const refund = yield* Refund;
      const command = new RefundMoney({ from: a, to: b, amount: 10 });
      expect(yield* Effect.flip(refund.send(command))).toEqual(new NotOwner());
      yield* refund.send(command).pipe(Effect.provideService(CurrentActor, { accountId: "a" }));
      expect(yield* accounts.get(b)).toEqual({ balance: 10 });
    }).pipe(Effect.provide(hosted)),
  );
});

describe("Domain decision, unique values", { tags: ["unit", "local"] }, () => {
  const sam = Username.make("sam");
  const c1 = CustomerId.make("c-1");
  const c2 = CustomerId.make("c-2");

  it.effect("two customers can't claim one username", () =>
    Effect.gen(function* () {
      const registration = yield* Registration;
      const first = yield* registration.send(
        new RegisterCustomer({ customerId: c1, name: "Sam", username: sam }),
      );
      expect(first.events).toEqual([
        new CustomerRegistered({ name: "Sam", username: sam }),
        new UsernameClaimed({ customerId: c1 }),
      ]);
      const second = yield* Effect.flip(
        registration.send(new RegisterCustomer({ customerId: c2, name: "Alex", username: sam })),
      );
      expect(second).toEqual(new UsernameTaken());
      expect(yield* (yield* Customer).get(c2)).toEqual({ _tag: "New" });
      expect(yield* (yield* UsernameClaim).get(sam)).toEqual({ _tag: "Claimed", customerId: c1 });
    }).pipe(Effect.provide(hosted)),
  );

  it.effect("a registered customer can't register again", () =>
    Effect.gen(function* () {
      const registration = yield* Registration;
      yield* registration.send(
        new RegisterCustomer({ customerId: c1, name: "Sam", username: sam }),
      );
      const again = yield* Effect.flip(
        registration.send(
          new RegisterCustomer({ customerId: c1, name: "Sam", username: Username.make("sam2") }),
        ),
      );
      expect(again).toEqual(new AlreadyRegistered());
      expect(yield* (yield* UsernameClaim).get(Username.make("sam2"))).toEqual({ _tag: "Free" });
    }).pipe(Effect.provide(hosted)),
  );

  it.effect("racing registrations for one username: exactly one wins", () =>
    Effect.gen(function* () {
      const registration = yield* Registration;
      const exits = yield* Effect.forEach(
        Array.from({ length: 8 }, (_, i) => CustomerId.make(`r-${i}`)),
        (customerId) =>
          Effect.exit(
            registration.send(new RegisterCustomer({ customerId, name: "Racer", username: sam })),
          ),
        { concurrency: "unbounded" },
      );
      expect(exits.filter(Exit.isSuccess).length).toBe(1);
    }).pipe(Effect.provide(hosted)),
  );
});

describe("Domain decision, definitions", { tags: ["unit"] }, () => {
  class Opened extends Domain.Event("Opened") {}
  class Open extends Domain.Command("Open", { input: { id: Schema.String }, events: [Opened] }) {}
  class OpenBoth extends Domain.Command("OpenBoth", {
    input: { left: Schema.String, right: Schema.String },
    events: [Opened],
  }) {}
  class Door extends Domain.Aggregate("Door", {
    id: Schema.String,
    state: Schema.Struct({ open: Schema.Boolean }),
    initial: { open: false },
    commands: [Open],
    target: { Open: (command) => command.id },
    decide: { Open: () => [new Opened()] },
    evolve: { Opened: () => ({ open: true }) },
  }) {}
  class Window extends Domain.Aggregate("Window", {
    id: Schema.String,
    state: Schema.Struct({ open: Schema.Boolean }),
    initial: { open: false },
    events: [Opened],
    evolve: { Opened: () => ({ open: true }) },
  }) {}
  class Both extends Domain.Decision(OpenBoth, {
    reads: (cmd) => ({ left: Door.ref(cmd.left), right: Door.ref(cmd.right) }),
    decide: ({ left, right }) => [left.record(new Opened()), right.record(new Opened())],
  }) {}
  class BothAgain extends Domain.Decision(OpenBoth, {
    reads: (cmd) => ({ left: Door.ref(cmd.left) }),
    decide: ({ left }) => [left.record(new Opened())],
  }) {}
  class Stray extends Domain.Decision(OpenBoth, {
    reads: (cmd) => ({ left: Door.ref(cmd.left), window: Window.ref(cmd.right) }),
    decide: ({ left }) => [left.record(new Opened())],
  }) {}

  it("a model with one implementation per command is valid", () => {
    class House extends Domain.Model("House", { aggregates: [Door], decisions: [Both] }) {}
    expect(Domain.verify(House)).toEqual([]);
    expect(House.commands.map((command) => command.tag)).toEqual(["Open", "OpenBoth"]);
  });

  it("two decisions for one command is a definition error", () => {
    class House extends Domain.Model("House", {
      aggregates: [Door],
      // @ts-expect-error OpenBoth is already implemented by another decision
      decisions: [Both, BothAgain],
    }) {}
    expect(Domain.verify(House).map((problem) => problem.reason._tag)).toEqual([
      "ImplementedTwice",
    ]);
  });

  it.effect("reading an aggregate the model doesn't host dies when the command is sent", () =>
    Effect.gen(function* () {
      class House extends Domain.Model("House", { aggregates: [Door], decisions: [Stray] }) {}
      const exit = yield* Effect.gen(function* () {
        const stray = yield* Stray;
        return yield* stray.send(new OpenBoth({ left: "l", right: "r" }));
      }).pipe(Effect.provide(House.layer(Layer.empty).pipe(Layer.provide(InMemory))), Effect.exit);
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("not in the Domain");
    }),
  );
});
