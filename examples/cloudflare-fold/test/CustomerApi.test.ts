import { expect, it } from "@effect/vitest";
import { InMemory } from "alchemy/Fold";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { mainAccountId } from "../src/Account/AccountId.ts";
import { Bank, BankPolicies } from "../src/Bank.ts";
import { CustomerId } from "../src/Customer/CustomerId.ts";
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
const mfa = { headers: { "x-mfa-code": "000000" } };

/** Each test gets a fresh bank. */
const inBank = <A, E>(effect: Effect.Effect<A, E, any>) =>
  effect.pipe(Effect.scoped, Effect.provide(World)) as Effect.Effect<A, E>;

it.live("register, then the live dashboard shows the main account", () =>
  inBank(
    Effect.gen(function* () {
      const sam = yield* asCustomer("c-1");
      const { accountId } = yield* sam.register({ name: "sam" });
      expect(accountId).toBe(mainAccountId(CustomerId.make("c-1")));
      const deposited = yield* sam.deposit({ accountId, amount: 250 });
      expect(deposited).toEqual({ accountId, owner: "sam", balance: 250, frozen: false });
      const dashboard = yield* sam.dashboard({}).pipe(
        Stream.filter((d) => d.accounts.length > 0 && d.totalBalance === 250),
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
      const { accountId } = yield* sam.register({ name: "sam" });
      yield* sam.deposit({ accountId, amount: 100 });

      const noMfa = yield* sam.withdraw({ accountId, amount: 10 }).pipe(Effect.flip);
      expect(noMfa._tag).toBe("MfaRequired");

      expect(yield* sam.withdraw({ accountId, amount: 10 }, mfa)).toEqual({ balance: 90 });

      const stolen = yield* alex.withdraw({ accountId, amount: 10 }, mfa).pipe(Effect.flip);
      expect(stolen._tag).toBe("NotOwner");
    }),
  ),
);

it.live("a request without a session is unauthorized", () =>
  inBank(
    Effect.gen(function* () {
      const anonymous = yield* CustomerApi.testClient.pipe(
        Effect.provide(customerSessionClient("nobody")),
      );
      const error = yield* anonymous.register({ name: "x" }).pipe(Effect.flip);
      expect(error._tag).toBe("Unauthorized");
    }),
  ),
);

it.live("a transfer completes and both sides can look it up", () =>
  inBank(
    Effect.gen(function* () {
      const sam = yield* asCustomer("c-1");
      const alex = yield* asCustomer("c-2");
      const from = (yield* sam.register({ name: "sam" })).accountId;
      const to = (yield* alex.register({ name: "alex" })).accountId;
      yield* sam.deposit({ accountId: from, amount: 100 });

      const outcome = yield* sam.transfer({ from, to, amount: 40 }, mfa);
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
      const { accountId } = yield* sam.register({ name: "sam" });
      yield* alex.register({ name: "alex" });

      const updates = yield* sam
        .account({ accountId })
        .pipe(Stream.result, Stream.take(2), Stream.runCollect, Effect.forkChild);
      yield* Effect.sleep("50 millis");
      yield* support.reassign({ accountId, customerId: CustomerId.make("c-2") });

      const [first, second] = yield* Fiber.join(updates);
      expect(first).toMatchObject({ _tag: "Success", success: { accountId, balance: 0 } });
      expect(second).toMatchObject({ _tag: "Failure", failure: { _tag: "NotOwner" } });
    }),
  ),
);
