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

// `allowPaths`: directories a relative import may leave the package for (a shared pure module).
const shared = bank("../shared");

tester.run("domain-imports (allowPaths)", domainImports, {
  valid: [
    {
      filename,
      code: `import { decide } from "../../../shared/pure/decide";`,
      options: [{ allowPaths: [shared] }],
    },
  ],
  invalid: [
    {
      filename,
      code: `import { BankWorker } from "../../../server/src/BankWorker.ts";`,
      options: [{ allowPaths: [shared] }],
      errors: [{ messageId: "outside" }],
    },
    // A sibling folder whose name starts with the allowed one is not inside it.
    {
      filename,
      code: `import { x } from "../../../shared-io/x.ts";`,
      options: [{ allowPaths: [shared] }],
      errors: [{ messageId: "outside" }],
    },
  ],
});
