import { oneBlockPerFile } from "../src/rules/one-block-per-file.ts";
import { bank, kennel, tester } from "./tester.ts";

const head = `import * as Domain from "@alchemy.run/domain";\n`;

tester.run("one-block-per-file", oneBlockPerFile, {
  valid: [
    {
      // A test may declare a model inline.
      filename: bank("test/Transfer.test.ts"),
      code: `import * as Domain from "@alchemy.run/domain";
class Transfer extends Domain.Aggregate("Transfer", {}) {}
class Move extends Domain.Saga("Move", {}) {}`,
    },
    {
      filename: bank("src/Account/WithdrawMoney.command.ts"),
      code: `${head}export class DailyLimitExceeded extends Domain.Rejection("DailyLimitExceeded") {}
export class Other extends Domain.Rejection("Other") {}
export class MoneyWithdrawn extends Domain.Event("MoneyWithdrawn", {}) {}
export class WithdrawMoney extends Domain.Command("WithdrawMoney", {}) {}`,
    },
    {
      filename: bank("src/Transfer/TransferExecution.policy.ts"),
      code: `${head}export class TransferExecution extends Domain.Policy("TransferExecution", {}) {}
export const TransferExecutionLive = TransferExecution.toLayer(Effect.gen(function* () {}));`,
    },
    {
      filename: bank("src/Account/AccountCard.stream.ts"),
      code: `${head}export class CardChanged extends Domain.Event("CardChanged", {}) {}
export class AccountCard extends Domain.Stream("AccountCard", {}) {}`,
    },
  ],
  invalid: [
    {
      filename: bank("src/Account/Commands.command.ts"),
      code: `${head}export class OpenAccount extends Domain.Command("OpenAccount", {}) {}
export class CloseAccount extends Domain.Command("CloseAccount", {}) {}`,
      errors: [
        {
          messageId: "extra",
          data: {
            kind: "Command",
            name: "CloseAccount",
            first: "OpenAccount",
            firstKind: "Command",
            suffix: "command",
            file: "CloseAccount.command.ts",
          },
        },
      ],
    },
    {
      filename: bank("src/Account/Account.aggregate.ts"),
      code: `${head}export class Account extends Domain.Aggregate("Account", {}) {}
export class AccountSummary extends Domain.View("AccountSummary", {}) {}
export class OpenAccount extends Domain.Command("OpenAccount", {}) {}`,
      errors: [
        {
          messageId: "extra",
          data: {
            kind: "View",
            name: "AccountSummary",
            first: "Account",
            firstKind: "Aggregate",
            suffix: "view",
            file: "AccountSummary.view.ts",
          },
        },
        {
          messageId: "extra",
          data: {
            kind: "Command",
            name: "OpenAccount",
            first: "Account",
            firstKind: "Aggregate",
            suffix: "command",
            file: "OpenAccount.command.ts",
          },
        },
      ],
    },
    {
      filename: bank("src/Account/NotOpen.rejection.ts"),
      code: `${head}export class NotOpen extends Domain.Rejection("NotOpen") {}
export class Closed extends Domain.Rejection("Closed") {}`,
      errors: [
        {
          messageId: "extra",
          data: {
            kind: "Rejection",
            name: "Closed",
            first: "NotOpen",
            firstKind: "Rejection",
            suffix: "rejection",
            file: "Closed.rejection.ts",
          },
        },
      ],
    },
  ],
});

tester.run("one-block-per-file (fileCase, messagesFile)", oneBlockPerFile, {
  valid: [
    {
      filename: kennel("src/dog/dog.messages.ts"),
      code: `${head}export class NotHungry extends Domain.Rejection("NotHungry") {}
export class Asleep extends Domain.Rejection("Asleep") {}
export class FeedDog extends Domain.Command("FeedDog", {}) {}
export class WalkDog extends Domain.Command("WalkDog", {}) {}`,
      options: [{ fileCase: "kebab", messagesFile: "messages" }],
    },
  ],
  invalid: [
    {
      filename: kennel("src/dog/dog.messages.ts"),
      code: `${head}export class FeedDog extends Domain.Command("FeedDog", {}) {}
export class WalkDog extends Domain.Command("WalkDog", {}) {}`,
      options: [{ fileCase: "kebab" }],
      errors: [
        {
          messageId: "extra",
          data: {
            kind: "Command",
            name: "WalkDog",
            first: "FeedDog",
            firstKind: "Command",
            file: "walk-dog.command.ts",
          },
        },
      ],
    },
  ],
});
