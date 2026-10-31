import { noCrossAggregateImport } from "../src/rules/no-cross-aggregate-import.ts";
import { bank, kennel, tester } from "./tester.ts";

const filename = bank("src/Account/Account.aggregate.ts");
const head = `import * as Domain from "@alchemy.run/domain";\n`;
const body = `\nexport class Account extends Domain.Aggregate("Account", { decide: {} }) {}`;

tester.run("no-cross-aggregate-import", noCrossAggregateImport, {
  valid: [
    { filename, code: `${head}import { CustomerId } from "../Customer/Customer.id.ts";${body}` },
    {
      filename,
      code: `${head}import type { Customer } from "../Customer/Customer.aggregate.ts";${body}`,
    },
    {
      filename,
      code: `${head}import { type Customer } from "../Customer/Customer.aggregate.ts";${body}`,
    },
    // A policy may use several aggregates.
    {
      filename: bank("src/Account/Provisioning.policy.ts"),
      code: `${head}import { Customer } from "../Customer/Customer.aggregate.ts";\nimport { Account } from "./Account.aggregate.ts";`,
    },
  ],
  invalid: [
    {
      filename,
      code: `${head}import { Customer } from "../Customer/Customer.aggregate.ts";${body}`,
      errors: [{ messageId: "cross", data: { aggregate: "Account", other: "Customer" } }],
    },
    {
      // Resolved by kind, not by file name.
      filename: bank("src/Transfer/Transfer.aggregate.ts"),
      code: `${head}import { Account as Acc } from "../Account/Account.aggregate.ts";
export class Transfer extends Domain.Aggregate("Transfer", { decide: {} }) {}`,
      errors: [{ messageId: "cross", data: { aggregate: "Transfer", other: "Acc" } }],
    },
    {
      // A package import named like an aggregate file.
      filename,
      code: `${head}import { Loan } from "@acme/lending/Loan/Loan.aggregate";${body}`,
      errors: [{ messageId: "cross" }],
    },
  ],
});

tester.run("no-cross-aggregate-import (kebab)", noCrossAggregateImport, {
  valid: [
    {
      filename: kennel("src/dog/dog.aggregate.ts"),
      code: `${head}import { FeedDog } from "./dog.messages";\nexport class Dog extends Domain.Aggregate("Dog", {}) {}`,
    },
  ],
  invalid: [
    {
      filename: kennel("src/dog/dog.aggregate.ts"),
      code: `${head}import { Cat } from "../cat/cat.aggregate";\nexport class Dog extends Domain.Aggregate("Dog", {}) {}`,
      errors: [{ messageId: "cross", data: { aggregate: "Dog", other: "Cat" } }],
    },
  ],
});
