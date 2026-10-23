import { aggregateIdFile } from "../src/rules/aggregate-id-file.ts";
import { bank, kennel, tester } from "./tester.ts";

const head = `import * as Domain from "@alchemy.run/domain";\n`;

tester.run("aggregate-id-file", aggregateIdFile, {
  valid: [
    {
      filename: bank("src/Account/Account.aggregate.ts"),
      code: `${head}import { AccountId } from "./Account.id.ts";
export class Account extends Domain.Aggregate("Account", { id: AccountId }) {}`,
    },
    {
      // An inline id expression is not an import to check.
      filename: bank("src/Customer/Customer.aggregate.ts"),
      code: `${head}export class Customer extends Domain.Aggregate("Customer", { id: Schema.String }) {}`,
    },
  ],
  invalid: [
    {
      filename: bank("src/Transfer/Transfer.aggregate.ts"),
      code: `${head}export class Transfer extends Domain.Aggregate("Transfer", { id: TransferId }) {}`,
      errors: [{ messageId: "missing", data: { name: "Transfer", expected: "Transfer.id.ts" } }],
    },
    {
      filename: bank("src/Account/Account.aggregate.ts"),
      code: `${head}import { AccountId } from "../ids.ts";
export class Account extends Domain.Aggregate("Account", { id: AccountId }) {}`,
      errors: [
        {
          messageId: "elsewhere",
          data: { name: "Account", expected: "Account.id.ts", actual: "../ids.ts" },
        },
      ],
    },
    {
      filename: bank("src/Account/Account.aggregate.ts"),
      code: `${head}const AccountId = Schema.String;
export class Account extends Domain.Aggregate("Account", { id: AccountId }) {}`,
      errors: [
        {
          messageId: "elsewhere",
          data: { name: "Account", expected: "Account.id.ts", actual: "this file" },
        },
      ],
    },
  ],
});

tester.run("aggregate-id-file (fileCase)", aggregateIdFile, {
  valid: [
    {
      filename: kennel("src/dog/dog.aggregate.ts"),
      code: `${head}import { DogId } from "./dog.id.ts";
export class Dog extends Domain.Aggregate("Dog", { id: DogId }) {}`,
      options: [{ fileCase: "kebab" }],
    },
  ],
  invalid: [
    {
      filename: kennel("src/cat/cat.aggregate.ts"),
      code: `${head}export class Cat extends Domain.Aggregate("Cat", { id: CatId }) {}`,
      options: [{ fileCase: "kebab" }],
      errors: [{ messageId: "missing", data: { name: "Cat", expected: "cat.id.ts" } }],
    },
    // The default case is pascal.
    {
      filename: kennel("src/dog/dog.aggregate.ts"),
      code: `${head}import { DogId } from "./dog.id.ts";
export class Dog extends Domain.Aggregate("Dog", { id: DogId }) {}`,
      errors: [{ messageId: "missing", data: { name: "Dog", expected: "Dog.id.ts" } }],
    },
  ],
});
