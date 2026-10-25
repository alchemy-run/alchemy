import { noThrow } from "../src/rules/no-throw.ts";
import { tester } from "./tester.ts";

const head = `import * as Domain from "@alchemy.run/domain";\n`;
const account = (parts: string, before = "") => `${head}${before}
export class Account extends Domain.Aggregate("Account", {
  ${parts}
}) {}`;

tester.run("no-throw", noThrow, {
  valid: [
    `const f = Effect.fn(function* () { return yield* new NotOpen(); });`,
    `const f = (s) => (s.open ? new AlreadyOpen() : []);`,
    `const e = new Error("built, not thrown");`,
    // A guard in `evolve`: the event cannot apply, so the command dies and nothing commits.
    account(
      `evolve: { MoneyDeposited: (s, e) => { if (!s.open) throw new Error("closed"); return s; } },`,
    ),
    // The guard in a helper that only `evolve` calls.
    account(
      `evolve: { MoneyDeposited: (s) => mustBeOpen(s), MoneyWithdrawn: (s) => ({ ...mustBeOpen(s) }) },`,
      `const mustBeOpen = (s) => { if (!s.open) throw new Error("closed"); return s; };`,
    ),
    // ... also called from `reply`, which reads the same next state (examples/cloudflare-domain).
    account(
      `evolve: { MoneyDeposited: (s) => mustBeOpen(s) },
  reply: { DepositMoney: (s) => ({ balance: mustBeOpen(s).balance }) },`,
      `function mustBeOpen(s) { if (!s.open) throw new Error("closed"); return s; }`,
    ),
    // ... or through another guard helper.
    account(
      `evolve: { MoneyDeposited: (s) => open(s) },`,
      `const mustBeOpen = (s) => { if (!s.open) throw new Error("closed"); return s; };
const open = (s) => mustBeOpen(s);`,
    ),
  ],
  invalid: [
    {
      code: `const mustBeOpen = (s) => { if (!s.open) throw new Error("closed"); return s; };`,
      errors: [{ messageId: "throw" }],
    },
    { code: `function f() { throw "x"; }`, errors: [{ messageId: "throw" }] },
    {
      // `decide` refuses with a rejection, never a throw.
      code: account(
        `decide: { WithdrawMoney: (s) => { if (!s.open) throw new Error("closed"); return []; } },`,
      ),
      errors: [{ messageId: "throw" }],
    },
    {
      // A helper `decide` also calls is not a guard.
      code: account(
        `decide: { WithdrawMoney: (s) => [mustBeOpen(s)] },
  evolve: { MoneyWithdrawn: (s) => mustBeOpen(s) },`,
        `const mustBeOpen = (s) => { if (!s.open) throw new Error("closed"); return s; };`,
      ),
      errors: [{ messageId: "throw" }],
    },
    {
      // Written in `reply` itself.
      code: account(
        `reply: { DepositMoney: (s) => { if (!s.open) throw new Error("closed"); return {}; } },`,
      ),
      errors: [{ messageId: "throw" }],
    },
    {
      // A helper only `reply` calls.
      code: account(
        `evolve: { MoneyDeposited: (s) => s },
  reply: { DepositMoney: (s) => ({ balance: mustBeOpen(s).balance }) },`,
        `const mustBeOpen = (s) => { if (!s.open) throw new Error("closed"); return s; };`,
      ),
      errors: [{ messageId: "throw" }],
    },
    {
      // A view's `evolve` is not an aggregate's.
      code: `${head}export class Summary extends Domain.View("Summary", {
  evolve: { MoneyDeposited: (s) => { if (!s) throw new Error("x"); return s; } },
}) {}`,
      errors: [{ messageId: "throw" }],
    },
    {
      // A policy handler.
      code: `${head}export class Refund extends Domain.Policy("Refund", {}) {}
export const RefundLive = Refund.toLayer(Effect.gen(function* () {
  return Effect.fn(function* ({ event }) { if (!event) throw new Error("x"); });
}));`,
      errors: [{ messageId: "throw" }],
    },
    {
      // A saga.
      code: `${head}export class Move extends Domain.Saga("Move", {}) {}
export const MoveLive = Move.toLayer(Effect.gen(function* () {
  return Effect.fn(function* () { throw new Error("x"); });
}));`,
      errors: [{ messageId: "throw" }],
    },
  ],
});
