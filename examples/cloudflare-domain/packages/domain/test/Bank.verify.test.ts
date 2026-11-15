import { Story } from "@alchemy.run/domain/Story";
import * as Verify from "@alchemy.run/domain/Verify";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Account } from "../src/Account/Account.aggregate.ts";
import { Bank, BankHandlers } from "../src/Bank.model.ts";
import { CustomerApi } from "../src/CustomerApi.api.ts";
import { FraudCheck } from "../src/Fraud/FraudCheck.external.ts";
import { MemoryLedgerStore } from "../src/Ledger/LedgerStore.ts";
import { Payments } from "../src/Settlement/Payments.external.ts";
import { SupportApi } from "../src/SupportApi.api.ts";

// The same runner the bank's stories use: each sequence the explorer finds is run with it.
const story = Story.make(Bank, {
  layer: BankHandlers.pipe(Layer.provide(MemoryLedgerStore)),
  stub: [FraudCheck, Payments],
});

it.effect(
  "the bank keeps its promises",
  () =>
    Effect.gen(function* () {
      const report = yield* Verify.model(Bank, { apis: [CustomerApi, SupportApi], story });
      const standing = Object.fromEntries(report.rules.map((rule) => [rule.name, rule.standing]));
      expect(standing).toEqual({
        // No state and no input break these: a solver decides each.
        "Account.NeverOverdrawn": "proved",
        "Account.WithinDailyLimit": "proved",
        "Account.AClosedAccountStaysClosed": "proved",
        "Account.MoneyLeavesOnlyByWithdrawalOrTransfer": "proved",
        "Account.OnlyAnAgentChangesTheOwner": "proved",
        // These are about several instances: no sequence of two commands breaks them.
        "Bank.TransfersLoseNoMoney": "checked",
        "Bank.NoTransferLeftPending": "checked",
        // What the Ledger projection is given, against what the accounts recorded.
        "Bank.LedgerIsGivenEveryDeposit": "checked",
        "Bank.EveryTransferEnds": "checked",
      });
      // Every sequence found ran on the real bank, with its policies, saga, views and
      // projections, and so did the walks of commands picked at random.
      expect(report.runs.length - report.walked).toBeGreaterThan(20);
      expect(report.walked).toBeGreaterThan(50);
      expect(report.explored.projections).toEqual(["Ledger"]);
      expect(report.undone).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  300_000,
);

it.effect(
  "an account keeps its rules",
  () => Verify.aggregate(Account).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);
