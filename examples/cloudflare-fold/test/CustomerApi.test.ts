import { expect, it } from "@effect/vitest";
import { InMemory } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { mainAccountId } from "../src/Account/AccountId.ts";
import { Bank, BankPolicies } from "../src/Bank.ts";
import { CustomerDashboard } from "../src/Customer/CustomerDashboard.ts";
import { CustomerId } from "../src/Customer/CustomerId.ts";
import { Username } from "../src/Customer/Username.ts";
import { CustomerApi } from "../src/CustomerApi/CustomerApi.ts";
import { SiftFraudCheck } from "../src/Fraud/SiftFraudCheck.ts";
import { MfaChallengeLive } from "../src/MfaChallenge.ts";
import { SessionLive, sessionClient } from "../src/Session.ts";
import { StripePayments } from "../src/Settlement/StripePayments.ts";
import { SupportApi } from "../src/SupportApi/SupportApi.ts";
import { mfa, register, transfer } from "./flows.ts";

// The whole bank in one process: the same Layers the Worker uses, on the in-memory platform.
const Ports = Layer.mergeAll(SiftFraudCheck, StripePayments);
const BankInMemory = Bank.layer(BankPolicies).pipe(Layer.provide(Layer.mergeAll(Ports, InMemory)));
const World = Layer.mergeAll(SessionLive, MfaChallengeLive).pipe(Layer.provideMerge(BankInMemory));

const asCustomer = (id: string) =>
  CustomerApi.testClient.pipe(Effect.provide(sessionClient(`customer:${id}`)));
const asAgent = (id: string) =>
  SupportApi.testClient.pipe(Effect.provide(sessionClient(`agent:${id}`)));

/** Each test gets a fresh bank. */
const inBank = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | Layer.Success<typeof World>>) =>
  effect.pipe(Effect.scoped, Effect.provide(World));

it.live("register, then the live dashboard shows the main account", () =>
  inBank(
    Effect.gen(function* () {
      const sam = yield* asCustomer("c-1");
      const accountId = yield* register(sam, "c-1", "sam");
      expect(accountId).toBe(mainAccountId(CustomerId.make("c-1")));
      const deposited = yield* sam.DepositMoney({ target: accountId, amount: 250 });
      expect(deposited).toEqual({
        reply: { balance: 250 },
        stream: `Account/${accountId}`,
        version: 2,
      });
      const dashboard = yield* sam.CustomerDashboard.watch(CustomerId.make("c-1")).pipe(
        Stream.filter((d) => d !== null && CustomerDashboard.computed.totalBalance(d) === 250),
        Stream.runHead,
      );
      expect(dashboard).toMatchObject({ _tag: "Some", value: { name: "sam" } });
    }),
  ),
);

it.live("withdrawing needs MFA, and only the owner may withdraw", () =>
  inBank(
    Effect.gen(function* () {
      const sam = yield* asCustomer("c-1");
      const alex = yield* asCustomer("c-2");
      const accountId = yield* register(sam, "c-1", "sam");
      yield* sam.DepositMoney({ target: accountId, amount: 100 });

      const noMfa = yield* sam.WithdrawMoney({ target: accountId, amount: 10 }).pipe(Effect.flip);
      expect(noMfa._tag).toBe("MfaRequired");

      const withdrawn = yield* sam.WithdrawMoney({ target: accountId, amount: 10 }, mfa);
      expect(withdrawn.reply).toEqual({ balance: 90 });

      const stolen = yield* alex
        .WithdrawMoney({ target: accountId, amount: 10 }, mfa)
        .pipe(Effect.flip);
      expect(stolen._tag).toBe("NotOwner");
    }),
  ),
);

it.live("a view is a security boundary: owners and agents read it, others are rejected", () =>
  inBank(
    Effect.gen(function* () {
      const sam = yield* asCustomer("c-1");
      const alex = yield* asCustomer("c-2");
      const support = yield* asAgent("support-7");
      const accountId = yield* register(sam, "c-1", "sam");
      const receipt = yield* sam.DepositMoney({ target: accountId, amount: 40 });
      const atLeast = { stream: receipt.stream, version: receipt.version };

      expect(yield* sam.AccountSummary.get(accountId, { atLeast })).toMatchObject({ balance: 40 });
      expect((yield* alex.AccountSummary.get(accountId).pipe(Effect.flip))._tag).toBe("NotOwner");
      expect(yield* support.AccountSummary.get(accountId)).toMatchObject({ balance: 40 });
      // A filter only narrows what a permitted read returns.
      expect(
        yield* sam.AccountSummary.get(accountId, { atLeast, where: { balance: { gt: 100 } } }),
      ).toBeNull();
      expect(
        (yield* alex.CustomerDashboard.get(CustomerId.make("c-1")).pipe(Effect.flip))._tag,
      ).toBe("Forbidden");
    }),
  ),
);

it.live("a customer watches their account's own events; others are rejected", () =>
  inBank(
    Effect.gen(function* () {
      const sam = yield* asCustomer("c-1");
      const alex = yield* asCustomer("c-2");
      const accountId = yield* register(sam, "c-1", "sam");
      yield* sam.DepositMoney({ target: accountId, amount: 70 });

      const events = yield* sam.Account.events(accountId).pipe(Stream.take(2), Stream.runCollect);
      expect(events.map((e) => e.event._tag)).toEqual(["AccountOpened", "MoneyDeposited"]);
      expect((yield* sam.Account.get(accountId))._tag).toBe("Open");
      expect((yield* alex.Account.get(accountId).pipe(Effect.flip))._tag).toBe("NotOwner");
    }),
  ),
);

it.live("a customer can only register themselves", () =>
  inBank(
    Effect.gen(function* () {
      const sam = yield* asCustomer("c-1");
      const error = yield* sam
        .RegisterCustomer({
          target: CustomerId.make("c-2"),
          name: "not sam",
          username: Username.make("not-sam"),
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("NotTheCustomer");
    }),
  ),
);

it.live("a request without a session is unauthorized", () =>
  inBank(
    Effect.gen(function* () {
      const anonymous = yield* CustomerApi.testClient.pipe(Effect.provide(sessionClient("nobody")));
      const error = yield* anonymous
        .RegisterCustomer({
          target: CustomerId.make("c-1"),
          name: "x",
          username: Username.make("x"),
        })
        .pipe(Effect.flip);
      expect(error._tag).toBe("Unauthorized");
    }),
  ),
);

it.live(
  "a transfer completes; the requester follows its status, the recipient sees it arrive",
  () =>
    inBank(
      Effect.gen(function* () {
        const sam = yield* asCustomer("c-1");
        const alex = yield* asCustomer("c-2");
        const from = yield* register(sam, "c-1", "sam");
        const to = yield* register(alex, "c-2", "alex");
        yield* sam.DepositMoney({ target: from, amount: 100 });

        const outcome = yield* transfer(sam, { transferId: "t-1", from, to, amount: 40 });
        expect(outcome.status).toBe("completed");
        // The status is the requester's; the recipient follows their own account.
        expect((yield* alex.TransferStatus.get(outcome.transferId).pipe(Effect.flip))._tag).toBe(
          "NotOwner",
        );
        const incoming = yield* alex.AccountTransfers.list(to);
        expect(incoming.entries.map((e) => e.event.direction)).toEqual(["in"]);

        const page = yield* sam.Statement.list(from, { order: "desc" });
        expect(page.entries.map((e) => e.event.kind)).toEqual(["transfer-out", "deposit"]);
      }),
    ),
);

it.live("a watch ends with NotOwner when support reassigns the account", () =>
  inBank(
    Effect.gen(function* () {
      const sam = yield* asCustomer("c-1");
      const alex = yield* asCustomer("c-2");
      const support = yield* asAgent("support-7");
      const accountId = yield* register(sam, "c-1", "sam");
      yield* register(alex, "c-2", "alex");

      const updates = yield* sam.AccountSummary.watch(accountId).pipe(
        Stream.result,
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.sleep("50 millis");
      yield* support.ChangeOwner({ target: accountId, customerId: CustomerId.make("c-2") });

      const [first, second] = yield* Fiber.join(updates);
      expect(first).toMatchObject({ _tag: "Success", success: { balance: 0 } });
      expect(second).toMatchObject({ _tag: "Failure", failure: { _tag: "NotOwner" } });
    }),
  ),
);
