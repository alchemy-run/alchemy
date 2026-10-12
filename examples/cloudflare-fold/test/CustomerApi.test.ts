import { expect, it } from "@effect/vitest";
import { InMemory } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { mainAccountId } from "../src/Account/AccountId.ts";
import { Bank, BankPolicies } from "../src/Bank.ts";
import { CustomerId } from "../src/Customer/CustomerId.ts";
import { Username } from "../src/Customer/Username.ts";
import { CustomerApi, CustomerApiLive } from "../src/CustomerApi/CustomerApi.ts";
import { CustomerSessionLive, customerSessionClient } from "../src/CustomerApi/CustomerSession.ts";
import { MfaChallengeLive } from "../src/CustomerApi/MfaChallenge.ts";
import { SiftFraudCheck } from "../src/Fraud/SiftFraudCheck.ts";
import { StripePayments } from "../src/Settlement/StripePayments.ts";
import {
  SupportAgentSessionLive,
  supportAgentSessionClient,
} from "../src/SupportApi/SupportAgentSession.ts";
import { SupportApi, SupportApiLive } from "../src/SupportApi/SupportApi.ts";
import { mfa, register, transfer } from "./flows.ts";

// The whole bank in one process: the same Layers the Worker uses, on the in-memory platform.
const Ports = Layer.mergeAll(SiftFraudCheck, StripePayments);
const BankInMemory = Bank.layer(BankPolicies).pipe(Layer.provide(Layer.mergeAll(Ports, InMemory)));
const World = Layer.mergeAll(
  CustomerApiLive,
  SupportApiLive,
  CustomerSessionLive,
  MfaChallengeLive,
  SupportAgentSessionLive,
).pipe(Layer.provideMerge(BankInMemory));

const asCustomer = (id: string) =>
  CustomerApi.testClient.pipe(Effect.provide(customerSessionClient(`customer:${id}`)));
const asAgent = (id: string) =>
  SupportApi.testClient.pipe(Effect.provide(supportAgentSessionClient(`agent:${id}`)));

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
      const dashboard = yield* sam.dashboard({}).pipe(
        Stream.filter((d) => d.totalBalance === 250),
        Stream.runHead,
      );
      expect(dashboard).toMatchObject({ _tag: "Some", value: { name: "sam", totalBalance: 250 } });
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
      const anonymous = yield* CustomerApi.testClient.pipe(
        Effect.provide(customerSessionClient("nobody")),
      );
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

it.live("a transfer completes and both sides can look it up", () =>
  inBank(
    Effect.gen(function* () {
      const sam = yield* asCustomer("c-1");
      const alex = yield* asCustomer("c-2");
      const from = yield* register(sam, "c-1", "sam");
      const to = yield* register(alex, "c-2", "alex");
      yield* sam.DepositMoney({ target: from, amount: 100 });

      const outcome = yield* transfer(sam, { transferId: "t-1", from, to, amount: 40 });
      expect(outcome.status).toBe("completed");
      expect((yield* alex.transferStatus({ transferId: outcome.transferId })).status).toBe(
        "completed",
      );

      const page = yield* sam.statement({ accountId: from });
      expect(page.entries.map((e) => e.kind)).toEqual(["transfer-out", "deposit"]);
    }),
  ),
);

it.live("an account subscription is revoked when support reassigns the account", () =>
  inBank(
    Effect.gen(function* () {
      const sam = yield* asCustomer("c-1");
      const alex = yield* asCustomer("c-2");
      const support = yield* asAgent("support-7");
      const accountId = yield* register(sam, "c-1", "sam");
      yield* register(alex, "c-2", "alex");

      const updates = yield* sam
        .account({ accountId })
        .pipe(Stream.result, Stream.take(2), Stream.runCollect, Effect.forkChild);
      yield* Effect.sleep("50 millis");
      yield* support.ChangeOwner({ target: accountId, customerId: CustomerId.make("c-2") });

      const [first, second] = yield* Fiber.join(updates);
      expect(first).toMatchObject({ _tag: "Success", success: { accountId, balance: 0 } });
      expect(second).toMatchObject({ _tag: "Failure", failure: { _tag: "NotOwner" } });
    }),
  ),
);
