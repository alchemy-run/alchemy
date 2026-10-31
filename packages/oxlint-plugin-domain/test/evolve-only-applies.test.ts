import { evolveOnlyApplies } from "../src/rules/evolve-only-applies.ts";
import { bank, tester } from "./tester.ts";

const filename = bank("src/Account/Account.aggregate.ts");
const header = `import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import { AccountOpened, AlreadyOpen } from "./OpenAccount.command.ts";
import { NotOpen } from "./NotOpen.rejection.ts";
`;
const aggregate = (evolve: string) =>
  `${header}export class Account extends Domain.Aggregate("Account", {
  decide: { OpenAccount: (s) => (s.open ? new AlreadyOpen() : [new AccountOpened({ owner: "x" })]) },
  evolve: { ${evolve} },
}) {}`;

tester.run("evolve-only-applies", evolveOnlyApplies, {
  valid: [
    {
      filename,
      code: aggregate(`AccountOpened: (s, e) => ({ ...s, open: true, owner: e.owner })`),
    },
    {
      filename,
      code: aggregate(
        `AccountOpened: (s, e, { at }) => { const next = { ...s, at }; return next; }`,
      ),
    },
    { filename, code: aggregate(`AccountClosed: () => ({ _tag: "Closed" as const })`) },
  ],
  invalid: [
    {
      filename,
      code: aggregate(`AccountOpened: Effect.fn(function* (s) { return s; })`),
      errors: [{ messageId: "effect", data: { handler: "AccountOpened" } }],
    },
    {
      filename,
      code: aggregate(`AccountOpened: function* (s) { return s; }`),
      errors: [{ messageId: "effect" }],
    },
    {
      filename,
      code: aggregate(`AccountOpened: async (s) => s`),
      errors: [{ messageId: "effect" }],
    },
    {
      filename,
      code: aggregate(`AccountOpened: (s) => Effect.succeed(s)`),
      errors: [{ messageId: "effect" }],
    },
    {
      // The rejection is declared in the imported command file.
      filename,
      code: aggregate(`AccountOpened: (s) => (s.open ? new AlreadyOpen() : { ...s, open: true })`),
      errors: [{ messageId: "rejects", data: { handler: "AccountOpened", name: "AlreadyOpen" } }],
    },
    {
      filename,
      code: aggregate(`MoneyDeposited: (s) => (s.open ? s : new NotOpen())`),
      errors: [{ messageId: "rejects", data: { handler: "MoneyDeposited", name: "NotOpen" } }],
    },
    {
      filename,
      code: aggregate(`AccountOpened: (s) => [new AccountOpened({ owner: "again" })]`),
      errors: [{ messageId: "records", data: { handler: "AccountOpened", name: "AccountOpened" } }],
    },
  ],
});
