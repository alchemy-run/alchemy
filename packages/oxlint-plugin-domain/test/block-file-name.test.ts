import { blockFileName } from "../src/rules/block-file-name.ts";
import { bank, kennel, tester } from "./tester.ts";

const head = `import * as Domain from "@alchemy.run/domain";\n`;

tester.run("block-file-name", blockFileName, {
  valid: [
    {
      filename: bank("src/Account/Account.aggregate.ts"),
      code: `${head}export class Account extends Domain.Aggregate("Account", {}) {}`,
    },
    {
      filename: bank("src/Account/WithdrawMoney.command.ts"),
      code: `${head}export class DailyLimitExceeded extends Domain.Rejection("DailyLimitExceeded") {}
export class MoneyWithdrawn extends Domain.Event("MoneyWithdrawn", {}) {}
export class WithdrawMoney extends Domain.Command("WithdrawMoney", {}) {}`,
    },
    {
      filename: bank("src/Account/NotOpen.rejection.ts"),
      code: `${head}export class NotOpen extends Domain.Rejection("NotOpen") {}`,
    },
    {
      filename: bank("src/Fraud/FraudCheck.external.ts"),
      code: `${head}export class FraudCheck extends Domain.ExternalSystem("FraudCheck", {}) {}`,
    },
    {
      filename: bank("src/CurrentActor.context.ts"),
      code: `${head}export class CurrentActor extends Domain.RequestContext<CurrentActor>()("Bank/CurrentActor", Actor) {}`,
    },
    {
      filename: bank("src/Session.middleware.ts"),
      code: `import { RpcMiddleware } from "effect/unstable/rpc";
export class Session extends RpcMiddleware.Service<Session, { provides: CurrentActor }>()("Bank/Session", {}) {}`,
    },
    {
      filename: bank("src/Bank.model.ts"),
      code: `${head}export class Bank extends Domain.Model("Bank", {}) {}`,
    },
    {
      filename: bank("src/CustomerApi.api.ts"),
      code: `${head}export class CustomerApi extends Domain.Api("CustomerApi", A, B) {}`,
    },
    // Plain values and helpers keep plain names.
    {
      filename: bank("src/Money.ts"),
      code: `import * as Schema from "effect/Schema";\nexport const Cents = Schema.Int;`,
    },
    {
      filename: bank("src/Account/Account.id.ts"),
      code: `import * as Schema from "effect/Schema";\nexport const AccountId = Schema.String;`,
    },
    // An event shared by several commands.
    {
      filename: bank("src/Transfer/TransferRequested.ts"),
      code: `${head}export class TransferRequested extends Domain.Event("TransferRequested", {}) {}`,
    },
    // Tests are not checked.
    {
      filename: bank("test/Bank.story.test.ts"),
      code: `${head}export class Fake extends Domain.Aggregate("Fake", {}) {}`,
    },
  ],
  invalid: [
    {
      filename: bank("src/Account/Account.ts"),
      code: `${head}export class Account extends Domain.Aggregate("Account", {}) {}`,
      errors: [
        {
          messageId: "name",
          data: {
            kind: "Aggregate",
            name: "Account",
            expected: "Account.aggregate.ts",
            actual: "Account.ts",
          },
        },
      ],
    },
    {
      filename: bank("src/Account/Withdraw.command.ts"),
      code: `${head}export class WithdrawMoney extends Domain.Command("WithdrawMoney", {}) {}`,
      errors: [
        {
          messageId: "name",
          data: {
            kind: "Command",
            name: "WithdrawMoney",
            expected: "WithdrawMoney.command.ts",
            actual: "Withdraw.command.ts",
          },
        },
      ],
    },
    {
      filename: bank("src/Account/Summary.ts"),
      code: `${head}export class AccountSummary extends Domain.View("AccountSummary", {}) {}`,
      errors: [
        {
          messageId: "name",
          data: {
            kind: "View",
            name: "AccountSummary",
            expected: "AccountSummary.view.ts",
            actual: "Summary.ts",
          },
        },
      ],
    },
    {
      filename: bank("src/Account/errors.ts"),
      code: `${head}export class NotOpen extends Domain.Rejection("NotOpen") {}`,
      errors: [
        {
          messageId: "name",
          data: {
            kind: "Rejection",
            name: "NotOpen",
            expected: "NotOpen.rejection.ts",
            actual: "errors.ts",
          },
        },
      ],
    },
    {
      filename: bank("src/Fraud/FraudCheck.ts"),
      code: `import { ExternalSystem } from "@alchemy.run/domain";\nexport class FraudCheck extends ExternalSystem("FraudCheck", {}) {}`,
      errors: [
        {
          messageId: "name",
          data: {
            kind: "ExternalSystem",
            name: "FraudCheck",
            expected: "FraudCheck.external.ts",
            actual: "FraudCheck.ts",
          },
        },
      ],
    },
    {
      filename: bank("src/Account/Account.aggregate.ts"),
      code: `export const helper = 1;`,
      errors: [
        {
          messageId: "empty",
          data: { actual: "Account.aggregate.ts", kind: "Aggregate", callee: "Domain.Aggregate" },
        },
      ],
    },
    {
      filename: bank("src/Session.middleware.ts"),
      code: `export const helper = 1;`,
      errors: [
        {
          messageId: "empty",
          data: {
            actual: "Session.middleware.ts",
            kind: "Middleware",
            callee: "RpcMiddleware.Service",
          },
        },
      ],
    },
  ],
});

const kebab = { fileCase: "kebab" } as const;
const grouped = { fileCase: "kebab", messagesFile: "messages" } as const;

tester.run("block-file-name (fileCase, messagesFile)", blockFileName, {
  valid: [
    {
      filename: kennel("src/dog/dog.aggregate.ts"),
      code: `${head}export class Dog extends Domain.Aggregate("Dog", {}) {}`,
      options: [kebab],
    },
    {
      filename: kennel("src/dog/feed-dog.command.ts"),
      code: `${head}export class DogFed extends Domain.Event("DogFed", {}) {}
export class FeedDog extends Domain.Command("FeedDog", {}) {}`,
      options: [kebab],
    },
    {
      filename: kennel("src/dog/not-hungry.rejection.ts"),
      code: `${head}export class NotHungry extends Domain.Rejection("NotHungry") {}`,
      options: [kebab],
    },
    {
      filename: kennel("src/gateway-job-queue.aggregate.ts"),
      code: `${head}export class GatewayJobQueue extends Domain.Aggregate("GatewayJobQueue", {}) {}`,
      options: [kebab],
    },
    {
      filename: kennel("src/atm-card.aggregate.ts"),
      code: `${head}export class ATMCard extends Domain.Aggregate("ATMCard", {}) {}`,
      options: [kebab],
    },
    // A messages file holds the commands, events and rejections of one aggregate.
    {
      filename: kennel("src/dog/dog.messages.ts"),
      code: `${head}export class NotHungry extends Domain.Rejection("NotHungry") {}
export class DogFed extends Domain.Event("DogFed", {}) {}
export class FeedDog extends Domain.Command("FeedDog", {}) {}
export class WalkDog extends Domain.Command("WalkDog", {}) {}`,
      options: [grouped],
    },
    {
      filename: bank("src/Account/Account.messages.ts"),
      code: `${head}export class OpenAccount extends Domain.Command("OpenAccount", {}) {}
export class CloseAccount extends Domain.Command("CloseAccount", {}) {}`,
      options: [{ messagesFile: "messages" }],
    },
  ],
  invalid: [
    {
      filename: kennel("src/dog/Dog.aggregate.ts"),
      code: `${head}export class Dog extends Domain.Aggregate("Dog", {}) {}`,
      options: [kebab],
      errors: [
        {
          messageId: "name",
          data: {
            kind: "Aggregate",
            name: "Dog",
            expected: "dog.aggregate.ts",
            actual: "Dog.aggregate.ts",
          },
        },
      ],
    },
    {
      filename: kennel("src/dog/feed.command.ts"),
      code: `${head}export class FeedDog extends Domain.Command("FeedDog", {}) {}`,
      options: [kebab],
      errors: [
        {
          messageId: "name",
          data: {
            kind: "Command",
            name: "FeedDog",
            expected: "feed-dog.command.ts",
            actual: "feed.command.ts",
          },
        },
      ],
    },
    // Without `messagesFile`, a grouped file is named for its first command.
    {
      filename: kennel("src/dog/dog.messages.ts"),
      code: `${head}export class FeedDog extends Domain.Command("FeedDog", {}) {}`,
      options: [kebab],
      errors: [
        {
          messageId: "name",
          data: {
            kind: "Command",
            name: "FeedDog",
            expected: "feed-dog.command.ts",
            actual: "dog.messages.ts",
          },
        },
      ],
    },
    // A messages file holds no other block.
    {
      filename: kennel("src/dog/dog.messages.ts"),
      code: `${head}export class FeedDog extends Domain.Command("FeedDog", {}) {}
export class Dog extends Domain.Aggregate("Dog", {}) {}
export class DogCard extends Domain.View("DogCard", {}) {}`,
      options: [grouped],
      errors: [
        {
          messageId: "messages",
          data: {
            kind: "Aggregate",
            name: "Dog",
            expected: "dog.aggregate.ts",
            actual: "dog.messages.ts",
          },
        },
        {
          messageId: "messages",
          data: {
            kind: "View",
            name: "DogCard",
            expected: "dog-card.view.ts",
            actual: "dog.messages.ts",
          },
        },
      ],
    },
  ],
});
