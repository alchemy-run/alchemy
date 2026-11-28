import * as AI from "@alchemy.run/ai";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Notes } from "./infra.ts";

/** A tagged tool: the contract here, the implementation as a Layer. */
export class Add extends AI.Tool<Add>()("add", {
  description: "Add two integers. Always use this tool to add numbers; never add them yourself.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Struct({ sum: Schema.Number }),
  replay: "safe",
}) {}

export const AddLive = Add.make(
  Effect.gen(function* () {
    return Effect.fn(function* ({ a, b }) {
      return { sum: a + b + 1000 };
    });
  }),
);

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

/** `AI.Glob` implemented here instead of by Pi: a fixed listing that needs no sandbox. */
export const GlobLive = AI.Glob.make(
  {
    description: "List the files matching a glob pattern. Always use this tool to list files.",
    parameters: Schema.Struct({ pattern: Schema.String }),
    success: Schema.Struct({ matches: Schema.Array(Schema.String) }),
    replay: "safe",
  },
  ({ pattern }) => ({ matches: [`OWN-GLOB-4711/${pattern}`] }),
);

/** The `codemode` section of the system prompt a conversation was last sent, if it has one. */
export const codemodeSection = (messages: unknown): string | undefined => {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const match = /<codemode>\n([\s\S]*?)\n<\/codemode>/.exec(value);
      if (match) found.push(match[1]!);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(messages);
  return found.at(-1);
};

/** A tool declared with its implementation: its Effect binds what the tool uses. */
export class SaveNote extends AI.Tool<SaveNote>()(
  "save_note",
  {
    description:
      "Save a note under a key. Use it whenever the user asks you to remember something.",
    parameters: Schema.Struct({ key: Schema.String, text: Schema.String }),
    success: Schema.Void,
  },
  Effect.gen(function* () {
    const notes = yield* Cloudflare.KV.ReadWriteNamespace(Notes);
    return Effect.fn(function* ({ key, text }) {
      yield* notes.put(key, text).pipe(Effect.orDie);
    });
  }),
) {}

/** The phase a conversation is in: state kept beside its transcript. */
export class Phase extends AI.State("phase", {
  schema: Schema.Struct({ phase: Schema.Literals(["research", "draft", "publish"]) }),
  initial: { phase: "research" },
}) {}

/** A tool that writes the state of the conversation whose model called it. */
export const Advance = AI.Tool(
  "advance",
  {
    description: "Say the research is done, so drafting can start. Call it when asked to advance.",
    parameters: Schema.Struct({}),
    success: Schema.Struct({ phase: Schema.String }),
  },
  Effect.fn(function* () {
    return yield* Phase.update(() => ({ phase: "draft" as const }));
  }),
);
