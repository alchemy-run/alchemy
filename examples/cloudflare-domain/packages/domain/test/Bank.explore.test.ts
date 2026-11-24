import * as Explore from "@alchemy.run/domain/Explore";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Account } from "../src/Account/Account.aggregate.ts";
import { Bank } from "../src/Bank.model.ts";
import { CustomerApi } from "../src/CustomerApi.api.ts";
import { SupportApi } from "../src/SupportApi.api.ts";
import { Careless } from "./fixtures/Careless.model.ts";

it.effect(
  "no three commands break an account",
  () =>
    Effect.gen(function* () {
      const report = yield* Explore.check(Account, {
        source: new URL("../src/Account/Account.aggregate.ts", import.meta.url),
        depth: 3,
      });
      // Every event and rejection an account declares can happen, and the
      // explorer read all of the code it ran.
      expect(report.outcomes.filter((outcome) => !outcome.story)).toEqual([]);
      expect(report.disagreements).toEqual([]);
      expect(report.unread).toEqual([]);
      expect(report.undecided).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

// Every event handled once, in the order written: three commands deep, the
// other orders and second deliveries are more than a test should wait for.
// `Bank.verify.test.ts` runs two commands deep with both.
const bank = (depth: number) =>
  Explore.check(Bank, {
    source: new URL("../src/Bank.model.ts", import.meta.url),
    apis: [CustomerApi, SupportApi],
    depth,
    faults: { redeliver: false, reorder: false, rerun: false },
  });

it.effect(
  "no two commands through the Apis break the bank",
  () =>
    Effect.gen(function* () {
      const report = yield* bank(2);
      expect([...report.followed].sort()).toEqual([
        "MainAccountProvisioning",
        "TransferApprovalDeadline",
        "TransferExecution",
      ]);
      expect(report.sagas).toEqual(["ExecuteTransfer"]);
      const story = (aggregate: string | undefined, command: string, tag: string) =>
        report.outcomes.find(
          (o) => o.aggregate === aggregate && o.command === command && o.tag === tag,
        )?.story;
      // Registering opens the customer's main account: a policy sends OpenAccount, no caller does.
      expect(story("Account", "OpenAccount", "AccountOpened")?.map((step) => step.by)).toContain(
        "MainAccountProvisioning",
      );
      // Registering is a decision across the customer and the username: it records on both at once.
      expect(
        story(undefined, "RegisterCustomer", "CustomerRegistered")?.[0]?.recorded,
      ).toMatchObject([
        { aggregate: "Customer", events: [{ _tag: "CustomerRegistered" }] },
        { aggregate: "UsernameClaim", events: [{ _tag: "UsernameClaimed" }] },
      ]);
      // A second registration with a taken username is rejected at once, by the same decision.
      const taken = story(undefined, "RegisterCustomer", "UsernameTaken");
      expect(taken?.map((step) => step.outcome._tag)).toEqual(["Accepted", "Accepted", "Rejected"]);
      expect(taken?.filter((step) => !step.by)).toHaveLength(2);
      // A transfer nobody approves expires: the deadline policy's schedule comes due a day later.
      const expired = story("Transfer", "ExpireTransfer", "TransferFailed");
      expect(expired?.map((step) => step.after)).toEqual([undefined, "24 hours"]);
      expect(expired?.[1]?.by).toBe("TransferApprovalDeadline");
      // A transfer from an account that was never opened fails, and the saga records why.
      const failed = report.endings.find((ending) => ending.ending === "fails with NotOpen")?.story;
      expect(failed?.map((step) => step.command)).toMatchObject([
        { _tag: "RequestTransfer" },
        { _tag: "DebitTransfer" },
        { _tag: "FailTransfer", reason: "source account not open" },
      ]);
      // A transfer that needs approval stops until it is approved or its window closes.
      expect(
        report.endings.find((ending) => ending.ending === "waits for approval")?.story,
      ).toHaveLength(1);
      // The bank's own invariants hold after every one of those sequences.
      expect(report.rules.map((rule) => [rule.name, rule.broken])).toEqual([
        ["TransfersLoseNoMoney", undefined],
        ["NoTransferLeftPending", undefined],
        ["LedgerIsGivenEveryDeposit", undefined],
        // The two relations are proved, so no sequence has to look at them.
        ["AClaimedNameBelongsToItsCustomer", undefined],
        ["ARegisteredCustomerHoldsTheirName", undefined],
      ]);
      expect(report.failures).toEqual([]);
      expect(report.unsettled).toBe(0);
      expect(report.disagreements).toEqual([]);
      expect(report.unread).toEqual([]);
      expect(report.undecided).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);

it.effect(
  "a transfer to an account that is not open gives the money back",
  () =>
    Effect.gen(function* () {
      const report = yield* bank(3);
      // Every way the transfer saga says it can end is reached. No command starts the
      // erasure, so the explorer never runs it: `Bank.story.test.ts` does.
      expect(
        report.endings.filter((ending) => ending.saga !== "EraseCustomer" && !ending.story),
      ).toEqual([]);
      // The debit ran, the credit was refused, and the refund ran before the failure was recorded.
      const refunded = report.endings.find(
        (ending) => ending.ending === "fails with DestinationClosed",
      )?.story;
      expect(
        refunded
          ?.filter((step) => step.by === "ExecuteTransfer")
          .map((step) => (step.command as { _tag: string })._tag),
      ).toEqual(["DebitTransfer", "CreditTransfer", "RefundTransfer", "FailTransfer"]);
      // Money moved by then, and none of it went missing.
      expect(report.rules.filter((rule) => rule.broken)).toEqual([]);
      // A transfer that waits for approval is not ended, and ends once its deadline runs.
      expect(report.eventually).toMatchObject([{ name: "EveryTransferEnds", broken: undefined }]);
      expect(report.eventually[0]?.states).toBeGreaterThan(0);
      // Nothing is left out: the view FraudReview reacts to is folded, and FraudCheck answers it.
      expect(report.skipped).toEqual([]);
      expect(report.views).toEqual(["DailyOutflow"]);
      expect(report.followed).toContain("FraudReview");
      expect(report.systems).toContain("FraudCheck");
      expect(report.failures).toEqual([]);
      expect(report.disagreements).toEqual([]);
      expect(report.unread).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  300_000,
);

it.effect(
  "a rule the model does not keep is broken by a sequence that runs on the real code",
  () =>
    Effect.gen(function* () {
      const options = {
        source: new URL("./fixtures/Careless.model.ts", import.meta.url),
        apis: [CustomerApi],
        instances: 1,
        depth: 3,
        faults: { redeliver: false, reorder: false, rerun: false },
      };
      const report = yield* Explore.report(Careless, options);
      const broken = (name: string) => report.rules.find((rule) => rule.name === name)?.broken;
      const tags = (name: string) =>
        broken(name)?.map((step) => (step.command as { _tag: string })._tag);
      // One command is enough: a transfer from an account nobody opened fails.
      expect(tags("NoTransferFails")).toEqual(["RequestTransfer", "DebitTransfer", "FailTransfer"]);
      // The explorer picks the deposit: one cent more than the rule allows.
      expect(tags("HoldsAtMostTenDollars")).toEqual([
        "RegisterCustomer",
        "OpenAccount",
        "DepositMoney",
      ]);
      expect(broken("HoldsAtMostTenDollars")?.at(-1)?.command).toMatchObject({ amount: 1001 });
      // The rule forgets refunds: a debit whose credit is refused is paid back, not credited.
      expect(tags("EveryDebitIsCredited")?.slice(-4)).toEqual([
        "DebitTransfer",
        "CreditTransfer",
        "RefundTransfer",
        "FailTransfer",
      ]);
      expect(report.disagreements).toEqual([]);
      expect(report.unread).toEqual([]);
      // `check` fails where `report` only tells.
      const failed = yield* Explore.check(Careless, { ...options, depth: 1 }).pipe(Effect.flip);
      expect(failed._tag).toBe("InvariantBroken");
    }).pipe(Effect.provide(NodeServices.layer)),
  60_000,
);
