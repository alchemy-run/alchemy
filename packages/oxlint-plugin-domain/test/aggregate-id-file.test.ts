import { aggregateIdFile } from "../src/rules/aggregate-id-file.ts";
import { bank, tester } from "./tester.ts";

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
