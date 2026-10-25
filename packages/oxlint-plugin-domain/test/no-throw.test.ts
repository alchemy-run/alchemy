import { noThrow } from "../src/rules/no-throw.ts";
import { tester } from "./tester.ts";

const head = `import * as Domain from "@alchemy.run/domain";\n`;
const isOpen = `const isOpen = (s) => s._tag === "Open";\n`;
const account = (parts: string, before = isOpen) => `${head}${before}
export class Account extends Domain.Aggregate("Account", {
  ${parts}
}) {}`;
const mustBeOpen = `const mustBeOpen = (s) => { if (!isOpen(s)) throw new Error("closed"); return s; };\n`;

tester.run("no-throw", noThrow, {
  valid: [
    `const f = Effect.fn(function* () { return yield* new NotOpen(); });`,
    `const f = (s) => (s.open ? new AlreadyOpen() : []);`,
    `const e = new Error("built, not thrown");`,
    // A guard written in `evolve`: the event cannot apply, so the command dies and nothing commits.
    account(
      `evolve: { MoneyDeposited: (s, e) => { if (!isOpen(s)) throw new Error("closed"); return s; } },`,
    ),
    // The pattern: one pure predicate; `decide` rejects, `evolve` throws, `reply` reads state.
    account(
      `decide: { WithdrawMoney: (s) => (isOpen(s) ? [] : new NotOpen()) },
  evolve: {
    MoneyWithdrawn: (s, e) => {
      if (!isOpen(s)) throw new Error("MoneyWithdrawn on a closed account");
      return { ...s, balance: e.balanceAfter };
    },
  },
  reply: { WithdrawMoney: (s) => ({ balance: s.balance }) },`,
    ),
  ],
  invalid: [
    {
      code: mustBeOpen,
      errors: [{ messageId: "throw" }],
    },
    { code: `function f() { throw "x"; }`, errors: [{ messageId: "throw" }] },
    {
      // A throwing helper is reported, even when only `evolve` calls it.
      code: account(`evolve: { MoneyDeposited: (s) => mustBeOpen(s) },`, isOpen + mustBeOpen),
      errors: [{ messageId: "throw" }],
    },
    {
      // ... and when `reply` calls it too (examples/cloudflare-domain before #2549).
      code: account(
        `evolve: { MoneyDeposited: (s) => mustBeOpen(s) },
  reply: { DepositMoney: (s) => ({ balance: mustBeOpen(s).balance }) },`,
        isOpen + mustBeOpen,
      ),
      errors: [{ messageId: "throw" }],
    },
    {
      // `reply` only reads state.
      code: account(
        `reply: { DepositMoney: (s) => { if (!isOpen(s)) throw new Error("closed"); return {}; } },`,
      ),
      errors: [{ messageId: "throw" }],
    },
    {
      // `decide` refuses with a rejection.
      code: account(
        `decide: { WithdrawMoney: (s) => { if (!isOpen(s)) throw new Error("closed"); return []; } },`,
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
