// The prover's models, called as the interpreter calls them, on values made
// here: what each does with arguments no handler a table writes gives it.

import * as Interpreter from "@alchemy.run/domain/Prove/internal/Interpreter";
import type { Loader } from "@alchemy.run/domain/Prove/internal/Source";
import * as Timeline from "@alchemy.run/domain/Prove/internal/Timeline";
import * as Value from "@alchemy.run/domain/Prove/internal/Value";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

export const site = {
  module: { path: "models.ts", lineStarts: [0] },
  node: { start: 0 },
} as unknown as Value.Site;

const interpreter = Interpreter.make({} as Loader, new Value.Run([]));

/** A function of the library, as the interpreter holds one. */
export const lib = (key: string): Value.V => {
  const at = key.lastIndexOf(":");
  return { _tag: "Lib", module: key.slice(0, at), path: key.slice(at + 1).split(".") } as Value.V;
};

/** A call, and what it gives run on a handler's timeline when it is an effect. */
export const call = (key: string, args: ReadonlyArray<Value.V>): Effect.Effect<Value.V, unknown> =>
  Effect.flatMap(interpreter.call(lib(key), args, site), ran);

/** A value given back by the library: an effect is run on a timeline of its own. */
export const ran = (v: Value.V): Effect.Effect<Value.V, unknown> =>
  v._tag === "Effect"
    ? Timeline.run(() => interpreter.current.run, site, v.run)
    : Effect.succeed(v);

/** Why the prover stopped, or the value it read. */
export const outcome = (self: Effect.Effect<Value.V, unknown>): Effect.Effect<string | Value.V> =>
  Effect.map(Effect.exit(self), (exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const failed = exit.cause.reasons.find((reason) => reason._tag === "Fail") as
      | { readonly error: { readonly reason?: string; readonly _tag?: string } }
      | undefined;
    return failed?.error.reason ?? failed?.error._tag ?? "died";
  });

export const num = Value.num;
export const str = Value.str;
export const undef = Value.undef;
