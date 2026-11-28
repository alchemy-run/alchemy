import { AccountId } from "@bank/domain/Account/Account.id";
import { CustomerId } from "@bank/domain/Customer/Customer.id";
import { Username } from "@bank/domain/Customer/Username";
import { CustomerApi } from "@bank/domain/CustomerApi.api";
import { Component } from "@effect/ui";
import { HtmlLocator, HtmlPlay } from "@effect/ui/html/testing";
import { TestHost } from "@effect/ui/testing";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { BankUI, History } from "../src/Bank.ts";
import { Client } from "./Domain.ts";

const accountId = AccountId.make("c-1-main");

it.live("shows the account's ledger rows through the AccountLedger query", () =>
  Effect.gen(function* () {
    const client = yield* CustomerApi.Client;
    const customerId = CustomerId.make("c-1");
    yield* client.RegisterCustomer({ customerId, name: "Sam", username: Username.make("sam") });
    // MainAccountProvisioning opens the account after the username is claimed.
    yield* client.AccountSummary.watch(accountId).pipe(
      Stream.filter(({ state }) => state !== null),
      Stream.runHead,
      Effect.timeout("10 seconds"),
    );
    const receipt = yield* client.DepositMoney({ accountId, amount: 1_000 });
    // Wait until the ledger projection applied the deposit.
    yield* client.AccountLedger(
      { account: accountId },
      { atLeast: [{ stream: receipt.stream, version: receipt.version }] },
    );
    // The History component over the same in-memory bank.
    const play = yield* HtmlPlay.make(
      History.pipe(
        Component.provide(
          BankUI.layer.pipe(Layer.provide(Layer.succeed(CustomerApi.Client, client))),
        ),
      ),
      { accountId },
    );
    yield* play
      .expect(HtmlLocator.role("list", { name: "History" }))
      .toHaveText("MoneyDeposited 10.00, balance 10.00");
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(Client, TestHost.layer()))),
);
