import * as YieldedAgent from "@alchemy.run/yielded-agent";
import { Agent, Output } from "@yielded/agent";
import * as Schema from "effect/Schema";
import { LookupCode, ReadFile, SlowCode, Withdraw, WriteFile } from "./tools.ts";

/** Yielded's own agent definition; its toolkit is made of `AI.Tool`s. */
export const Assistant = Agent.make("assistant", {
  input: Schema.String,
  output: Output.text(Schema.String),
  instructions:
    "You are terse. Use your tools whenever they apply, then report what the tool returned in one sentence.",
  toolkit: YieldedAgent.toolkit(LookupCode, Withdraw),
  policy: { maxTurns: 6, maxToolCalls: 6, maxDuration: "90 seconds" },
});

/** An agent whose tools work on the Thread's sandbox. */
export const Clerk = Agent.make("clerk", {
  input: Schema.String,
  output: Output.text(Schema.String),
  instructions:
    "You keep files in a Linux sandbox. Do exactly what the user asks with the tool they name, then answer in one sentence.",
  toolkit: YieldedAgent.toolkit(WriteFile, ReadFile),
  policy: { maxTurns: 6, maxToolCalls: 6, maxDuration: "120 seconds" },
});

/** An agent whose one tool is slow, for runs that are cut off part way. */
export const Patient = Agent.make("patient", {
  input: Schema.String,
  output: Output.text(Schema.String),
  instructions:
    "You are terse. Use your tools whenever they apply, then report what the tool returned in one sentence.",
  toolkit: YieldedAgent.toolkit(SlowCode),
  policy: { maxTurns: 6, maxToolCalls: 6, maxDuration: "90 seconds" },
});
