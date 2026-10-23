import { noChainedProvide } from "../src/rules/no-chained-provide.ts";
import { tester } from "./tester.ts";

tester.run("no-chained-provide", noChainedProvide, {
  valid: [
    `program.pipe(Effect.provide(BankLive));`,
    `program.pipe(Effect.scoped, Effect.provide(World));`,
    `program.pipe(Effect.provide(Layer.mergeAll(A, B).pipe(Layer.provide(C))));`,
    // provideService stands in for middleware.
    `accounts.send(ref, cmd).pipe(Effect.provideService(CurrentActor, system), Effect.provide(Live));`,
    `Effect.provide(program, BankLive);`,
    `const a = x.pipe(Effect.provide(A)); const b = y.pipe(Effect.provide(B));`,
  ],
  invalid: [
    {
      code: `program.pipe(Effect.provide(A), Effect.provide(B));`,
      errors: [{ messageId: "chained" }],
    },
    {
      code: `program.pipe(Effect.provide(A)).pipe(Effect.provide(B));`,
      errors: [{ messageId: "chained" }],
    },
    {
      code: `program.pipe(Effect.provide(A), Effect.scoped, Effect.provide(B), Effect.provide(C));`,
      errors: [{ messageId: "chained" }, { messageId: "chained" }],
    },
    {
      code: `pipe(program, Effect.provide(A), Effect.provide(B));`,
      errors: [{ messageId: "chained" }],
    },
    {
      code: `Effect.provide(Effect.provide(program, A), B);`,
      errors: [{ messageId: "chained" }],
    },
    {
      code: `Effect.provide(program.pipe(Effect.provide(A)), B);`,
      errors: [{ messageId: "chained" }],
    },
  ],
});
