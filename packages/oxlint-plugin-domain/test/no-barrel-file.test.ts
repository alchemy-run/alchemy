import { noBarrelFile } from "../src/rules/no-barrel-file.ts";
import { tester } from "./tester.ts";

tester.run("no-barrel-file", noBarrelFile, {
  valid: [
    `export const Cents = Schema.Int;`,
    `export { Account } from "./Account.aggregate.ts";\nexport const extra = 1;`,
    ``,
  ],
  invalid: [
    {
      code: `export * from "./Account.aggregate.ts";\nexport { OpenAccount } from "./OpenAccount.command.ts";`,
      errors: [{ messageId: "barrel" }],
    },
    { code: `export * as Account from "./Account/index.ts";`, errors: [{ messageId: "barrel" }] },
  ],
});
