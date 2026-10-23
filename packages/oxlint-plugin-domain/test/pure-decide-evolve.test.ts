import { pureDecideEvolve } from "../src/rules/pure-decide-evolve.ts";
import { tester } from "./tester.ts";

const header = `import * as Domain from "@alchemy.run/domain";\nimport * as Effect from "effect/Effect";\n`;
const aggregate = (decide: string, evolve = "", extra = "") =>
  `${header}${extra}\nexport class Account extends Domain.Aggregate("Account", {
  id: AccountId, state: State, initial: {}, commands: [OpenAccount],
  decide: { ${decide} },
  evolve: { ${evolve} },
}) {}`;

tester.run("pure-decide-evolve", pureDecideEvolve, {
  valid: [
    aggregate(`OpenAccount: (s, cmd) => [new AccountOpened({ owner: cmd.owner })]`),
    aggregate(
      `WithdrawMoney: Effect.fn(function* (s, cmd, { now }) { const actor = yield* CurrentActor; return [new MoneyWithdrawn({ at: now })]; })`,
      `MoneyWithdrawn: (s, e, { at }) => ({ ...s, day: at })`,
    ),
    // Outside decide / evolve, the clock is fine.
    `${header}const stamp = () => Date.now();\nexport const later = Effect.sync(() => new Date());`,
    // new Date(x) converts; it does not read the clock.
    aggregate(
      `OpenAccount: (s, cmd) => [new AccountOpened({ on: new Date(cmd.at).toISOString() })]`,
    ),
    // A helper that is not called from decide.
    aggregate(`OpenAccount: (s) => []`, "", `const unused = () => Math.random();`),
  ],
  invalid: [
    {
      code: aggregate(`OpenAccount: (s, cmd) => [new AccountOpened({ at: Date.now() })]`),
      errors: [
        { messageId: "impure", data: { part: "Account.decide", what: "Date.now()", via: "" } },
      ],
    },
    {
      code: aggregate(`OpenAccount: (s, cmd) => [new AccountOpened({ id: crypto.randomUUID() })]`),
      errors: [{ messageId: "impure" }],
    },
    {
      code: aggregate(
        `OpenAccount: () => []`,
        `AccountOpened: (s) => ({ ...s, openedAt: new Date() })`,
      ),
      errors: [
        { messageId: "impure", data: { part: "Account.evolve", what: "new Date()", via: "" } },
      ],
    },
    {
      code: aggregate(
        `OpenAccount: Effect.fn(function* () { const t = yield* Clock.currentTimeMillis; return []; })`,
      ),
      errors: [
        {
          messageId: "impure",
          data: { part: "Account.decide", what: "Clock.currentTimeMillis", via: "" },
        },
      ],
    },
    {
      code: aggregate(
        `OpenAccount: Effect.fn(function* () { const n = yield* Random.next; return []; })`,
      ),
      errors: [{ messageId: "impure" }],
    },
    {
      code: aggregate(
        `OpenAccount: Effect.fn(function* () { const now = yield* DateTime.now; return []; })`,
      ),
      errors: [{ messageId: "impure" }],
    },
    {
      code: aggregate(`OpenAccount: (s) => (Math.random() > 0.5 ? [] : [])`),
      errors: [{ messageId: "impure" }],
    },
    {
      code: aggregate(
        `OpenAccount: Effect.fn(function* () { yield* Effect.promise(() => fetch("https://x")); return []; })`,
      ),
      errors: [
        { messageId: "io", data: { part: "Account.decide", what: "Effect.promise", via: "" } },
        { messageId: "io" },
      ],
    },
    {
      code: aggregate(`OpenAccount: (s) => (process.env.OPEN ? [] : [])`),
      errors: [{ messageId: "io", data: { part: "Account.decide", what: "process", via: "" } }],
    },
    {
      // Reached through a local helper.
      code: aggregate(
        `OpenAccount: (s) => [new AccountOpened({ id: newId() })]`,
        "",
        `const newId = () => crypto.randomUUID();`,
      ),
      errors: [
        {
          messageId: "impure",
          data: { part: "Account.decide", what: "crypto.randomUUID()", via: "through `newId`, " },
        },
      ],
    },
    {
      code: `${header}export class Summary extends Domain.View("Summary", {
  from: [Account], key: Account, state: State, initial: {},
  evolve: { AccountOpened: (v) => ({ ...v, seen: Date.now() }) },
}) {}`,
      errors: [
        { messageId: "impure", data: { part: "Summary.evolve", what: "Date.now()", via: "" } },
      ],
    },
    {
      code: `import { Aggregate } from "@alchemy.run/domain";
export class Account extends Aggregate("Account", { decide: { Open: () => [new Opened({ at: Date.now() })] } }) {}`,
      errors: [{ messageId: "impure" }],
    },
  ],
});
