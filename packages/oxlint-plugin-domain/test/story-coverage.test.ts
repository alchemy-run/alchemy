import { storyCoverage } from "../src/rules/story-coverage.ts";
import { bank, tester } from "./tester.ts";

const head = `import * as Domain from "@alchemy.run/domain";\n`;

tester.run("story-coverage", storyCoverage, {
  valid: [
    // Sent by a story.
    {
      filename: bank("src/Account/OpenAccount.command.ts"),
      code: `${head}export class OpenAccount extends Domain.Command("OpenAccount", { events: [AccountOpened] }) {}`,
    },
    // Shown through one of its events (a command only a policy sends).
    {
      filename: bank("src/Account/WithdrawMoney.command.ts"),
      code: `${head}export class WithdrawMoney extends Domain.Command("WithdrawMoney", { events: [MoneyWithdrawn] }) {}`,
    },
    {
      filename: bank("src/Account/NotOpen.rejection.ts"),
      code: `${head}export class NotOpen extends Domain.Rejection("NotOpen") {}`,
    },
    // Only commands and rejections are checked.
    {
      filename: bank("src/Account/Account.aggregate.ts"),
      code: `${head}export class Account extends Domain.Aggregate("Account", {}) {}`,
    },
  ],
  invalid: [
    {
      filename: bank("src/Account/Frozen.rejection.ts"),
      code: `${head}export class Frozen extends Domain.Rejection("Frozen") {}`,
      errors: [{ messageId: "rejection", data: { name: "Frozen" } }],
    },
    {
      filename: bank("src/Account/CloseAccount.command.ts"),
      code: `${head}export class AccountClosed extends Domain.Event("AccountClosed", {}) {}
export class CloseAccount extends Domain.Command("CloseAccount", { events: [AccountClosed] }) {}`,
      errors: [{ messageId: "command", data: { name: "CloseAccount" } }],
    },
    {
      // A story that only names the class (an import) does not cover it.
      filename: bank("src/Account/OpenAccount.command.ts"),
      code: `${head}export class AlreadyOpen extends Domain.Rejection("AlreadyOpen") {}`,
      errors: [{ messageId: "rejection", data: { name: "AlreadyOpen" } }],
    },
  ],
});
