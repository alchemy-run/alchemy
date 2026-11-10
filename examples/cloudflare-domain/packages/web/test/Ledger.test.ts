import { AccountId } from "@bank/domain/Account/Account.id";
import { CustomerId } from "@bank/domain/Customer/Customer.id";
import { Username } from "@bank/domain/Customer/Username";
import { CustomerApi } from "@bank/domain/CustomerApi.api";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { BankClient } from "../src/Bank.ts";
import { Client } from "./Domain.ts";

const accountId = AccountId.make("c-1-main");

it.live("reads the ledger through the AccountLedger query, after the app's own write", () =>
  Effect.gen(function* () {
    const client = yield* CustomerApi.Client;
    const customerId = CustomerId.make("c-1");
    yield* client.RegisterCustomer(customerId, { name: "Sam", username: Username.make("sam") });
    // MainAccountProvisioning opens the account after the username is claimed.
    yield* client.AccountSummary.watch(accountId).pipe(
      Stream.filter(({ state }) => state !== null),
      Stream.runHead,
      Effect.timeout("10 seconds"),
    );
    const receipt = yield* client.DepositMoney(accountId, { amount: 1_000 });
    const page = yield* BankClient.AccountLedger({
      input: { account: accountId },
      requestId: "page:0",
      atLeast: { stream: receipt.stream, version: receipt.version },
    }).effect;
    expect(page).toMatchObject({
      _tag: "SucceededAccountLedger",
      requestId: "page:0",
      result: { entries: [{ kind: "MoneyDeposited", amount: 1_000 }], cursor: null },
    });
  }).pipe(Effect.provide(Client)),
);
