import { noThrow } from "../src/rules/no-throw.ts";
import { tester } from "./tester.ts";

tester.run("no-throw", noThrow, {
  valid: [
    `const f = Effect.fn(function* () { return yield* new NotOpen(); });`,
    `const f = (s) => (s.open ? new AlreadyOpen() : []);`,
    `const e = new Error("built, not thrown");`,
  ],
  invalid: [
    {
      code: `const mustBeOpen = (s) => { if (!s.open) throw new Error("closed"); return s; };`,
      errors: [{ messageId: "throw" }],
    },
    { code: `function f() { throw "x"; }`, errors: [{ messageId: "throw" }] },
  ],
});
