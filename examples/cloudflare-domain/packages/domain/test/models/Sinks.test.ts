import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { call, num, outcome } from "./harness.ts";

const W = /is called in a way the prover has no model for/;

it.effect("a sink given what it does not take is reported", () =>
  Effect.gen(function* () {
    const stream = yield* call("effect/Stream:make", [num(1), num(2)]);
    const runInto = (sink: string, args: ReadonlyArray<ReturnType<typeof num>>) =>
      Effect.flatMap(call(sink, args), (made) => call("effect/Stream:run", [stream, made]));
    expect(yield* outcome(runInto("effect/Sink:failCause", [num(1)]))).toMatch(W);
    expect(yield* outcome(runInto("effect/Sink:fromQueue", [num(1)]))).toMatch(W);
  }),
);
