import { domainImports } from "../src/rules/domain-imports.ts";
import { bank, tester } from "./tester.ts";

const filename = bank("src/Account/Thing.ts");

tester.run("domain-imports", domainImports, {
  valid: [
    { filename, code: `import * as Domain from "@alchemy.run/domain";` },
    { filename, code: `import { Story } from "@alchemy.run/domain/Story";` },
    { filename, code: `import * as Effect from "effect/Effect"; import { Schema } from "effect";` },
    {
      filename,
      code: `import { AccountId } from "./Account.id.ts"; import { x } from "../Customer/Customer.id.ts";`,
    },
    { filename, code: `import type { RuntimeContext } from "alchemy";` },
    { filename, code: `import { type RuntimeContext } from "alchemy";` },
    {
      filename,
      code: `import { Stripe } from "@acme/payments";`,
      options: [{ allow: ["@acme/payments"] }],
    },
  ],
  invalid: [
    {
      filename,
      code: `import * as Cloudflare from "@alchemy.run/cloudflare";`,
      errors: [{ messageId: "forbidden", data: { source: "@alchemy.run/cloudflare" } }],
    },
    { filename, code: `import * as fs from "node:fs";`, errors: [{ messageId: "forbidden" }] },
    { filename, code: `import { Stack } from "alchemy";`, errors: [{ messageId: "forbidden" }] },
    {
      filename,
      code: `import type { RuntimeContext } from "alchemy";`,
      options: [{ allowTypes: [] }],
      errors: [{ messageId: "forbidden" }],
    },
    { filename, code: `export * from "drizzle-orm";`, errors: [{ messageId: "forbidden" }] },
    { filename, code: `const m = await import("stripe");`, errors: [{ messageId: "forbidden" }] },
    { filename, code: `const m = require("stripe");`, errors: [{ messageId: "forbidden" }] },
    {
      filename,
      code: `import { BankWorker } from "../../../server/src/BankWorker.ts";`,
      errors: [{ messageId: "outside" }],
    },
  ],
});
