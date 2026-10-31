import { relativeImportExtension } from "../src/rules/relative-import-extension.ts";
import { tester } from "./tester.ts";

tester.run("relative-import-extension", relativeImportExtension, {
  valid: [
    `import { AccountId } from "./Account.id.ts";`,
    `import { x } from "../Money.ts";`,
    `import * as Domain from "@alchemy.run/domain";`,
    `import { Bank } from "@acme/domain/Bank.model";`,
    `export * from "./Account.aggregate.ts";`,
  ],
  invalid: [
    {
      code: `import { AccountId } from "./Account.id";`,
      errors: [{ messageId: "extension", data: { source: "./Account.id" } }],
    },
    { code: `export { Money } from "../Money";`, errors: [{ messageId: "extension" }] },
    { code: `const m = await import("./Bank.model");`, errors: [{ messageId: "extension" }] },
    { code: `import { a } from "./Account.js";`, errors: [{ messageId: "extension" }] },
  ],
});
