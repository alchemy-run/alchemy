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

const bank = (depth: number) =>
  Explore.check(Bank, {
    source: new URL("../src/Bank.model.ts", import.meta.url),
    apis: [CustomerApi, SupportApi],
    depth,
    // FraudReview reacts to a view, which the explorer does not follow yet.
    allow: { skipped: ["FraudReview"] },
  });

it.effect(
  "no two commands through the Apis break the bank",
  () =>
    Effect.gen(function* () {
      const report = yield* bank(2);
      expect(report.followed).toEqual([
        "UsernameReservation",
        "MainAccountProvisioning",
        "TransferExecution",
        "TransferApprovalDeadline",
      ]);
      expect(report.sagas).toEqual(["ExecuteTransfer"]);
      const story = (aggregate: string, command: string, tag: string) =>
        report.outcomes.find(
          (o) => o.aggregate === aggregate && o.command === command && o.tag === tag,
        )?.story;
      // Registering opens the customer's main account: a policy sends OpenAccount, no caller does.
      expect(story("Account", "OpenAccount", "AccountOpened")?.map((step) => step.by)).toContain(
        "MainAccountProvisioning",
      );
      // A second registration with a taken username is rejected by the policy that claims it.
      expect(
        story("Customer", "RejectRegistration", "RegistrationRejected")?.filter((step) => !step.by),
      ).toHaveLength(2);
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
      // A transfer that needs approval stops until the decision comes.
      expect(
        report.endings.find((ending) => ending.ending === "waits for decision")?.story,
      ).toHaveLength(1);
      // The bank's own invariants hold after every one of those sequences.
      expect(report.rules.map((rule) => [rule.name, rule.broken])).toEqual([
        ["TransfersLoseNoMoney", undefined],
        ["NoTransferLeftPending", undefined],
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
      // Every way the saga says it can end is reached.
      expect(report.endings.filter((ending) => !ending.story)).toEqual([]);
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
      expect(report.failures).toEqual([]);
      expect(report.disagreements).toEqual([]);
      expect(report.unread).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  120_000,
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
        "ClaimUsername",
        "ConfirmRegistration",
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
