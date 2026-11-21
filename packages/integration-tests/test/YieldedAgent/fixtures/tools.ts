import * as AI from "@alchemy.run/ai";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A tagged tool: the contract here, the implementation as a Layer. */
export class LookupCode extends AI.Tool<LookupCode>()("lookup_code", {
  description: "Look up the secret code for a word. The only way to learn a word's code.",
  parameters: Schema.Struct({ word: Schema.String, digits: Schema.Number }),
  success: Schema.Struct({ code: Schema.String }),
  replay: "safe",
}) {}

/** A code the model cannot know without the tool. */
export const LookupCodeLive = LookupCode.make(({ word, digits }) => ({
  code: `CODE-${word.toUpperCase()}-${String(7391).slice(0, digits)}`,
}));

export class InsufficientFunds extends Schema.TaggedError<InsufficientFunds>()(
  "InsufficientFunds",
  { balance: Schema.Number },
) {}
export class AccountFrozen extends Schema.TaggedError<AccountFrozen>()("AccountFrozen", {
  account: Schema.String,
}) {}

/** A tool that fails with one of two declared errors. */
export class Withdraw extends AI.Tool<Withdraw>()("withdraw", {
  description: "Withdraw money from an account. Always use this tool to withdraw.",
  parameters: Schema.Struct({ account: Schema.String, amount: Schema.Number }),
  success: Schema.Struct({ balance: Schema.Number }),
  failure: Schema.Union([InsufficientFunds, AccountFrozen]),
  replay: "safe",
}) {}

export const WithdrawLive = Withdraw.make(
  Effect.fn(function* ({ account, amount }) {
    if (account === "frozen") return yield* new AccountFrozen({ account });
    if (amount > 137) return yield* new InsufficientFunds({ balance: 137 });
    return { balance: 137 - amount };
  }),
);

/** A tool that works in the Thread's sandbox, through `AI.Sandbox`. */
export class WriteFile extends AI.Tool<WriteFile>()("write_file", {
  description: "Write text to a file in the sandbox. Always use this tool to create a file.",
  parameters: Schema.Struct({ path: Schema.String, text: Schema.String }),
  success: Schema.Struct({ bytes: Schema.Number }),
}) {}

export const WriteFileLive = WriteFile.make(
  Effect.fn(function* ({ path, text }) {
    const sandbox = yield* AI.Sandbox;
    yield* sandbox.writeFile(path, text).pipe(Effect.orDie);
    return { bytes: new TextEncoder().encode(text).length };
  }),
);

export class ReadFile extends AI.Tool<ReadFile>()("read_file", {
  description: "Read a text file in the sandbox. Always use this tool to read a file.",
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.Struct({ text: Schema.String }),
  failure: Schema.TaggedStruct("FileNotFound", { path: Schema.String }),
  replay: "safe",
}) {}

export const ReadFileLive = ReadFile.make(
  Effect.fn(function* ({ path }) {
    const sandbox = yield* AI.Sandbox;
    const text = yield* sandbox
      .readTextFile(path)
      .pipe(Effect.mapError(() => ({ _tag: "FileNotFound" as const, path })));
    return { text };
  }),
);

/** A tool that takes a while: long enough for a test to kill the instance while it runs. */
export class SlowCode extends AI.Tool<SlowCode>()("slow_code", {
  description: "Look up the slow secret code for a word. The only way to learn a word's slow code.",
  parameters: Schema.Struct({ word: Schema.String }),
  success: Schema.Struct({ code: Schema.String }),
  replay: "safe",
}) {}

export const SlowCodeLive = SlowCode.make(
  Effect.fn(function* ({ word }) {
    yield* Effect.sleep("8 seconds");
    return { code: `SLOW-${word.toUpperCase()}-4242` };
  }),
);
