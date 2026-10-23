import { oneBlockPerFile } from "../src/rules/one-block-per-file.ts";
import { bank, tester } from "./tester.ts";

const head = `import * as Domain from "@alchemy.run/domain";\n`;

tester.run("one-block-per-file", oneBlockPerFile, {
  valid: [
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
          },
        },
      ],
    },
  ],
});
