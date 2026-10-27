import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as Schema from "effect/Schema";
import * as Foldkit from "../src/Foldkit.ts";
import { Client, CounterApi, CounterId } from "./Counter.ts";

const Counter = Foldkit.commands(CounterApi);
const target = CounterId.make("one");

it.effect("keeps reply, receipt and the caller's id on success", () =>
  Effect.gen(function* () {
    const result = yield* Counter.Increment({ target, input: { amount: 2 }, commandId: "page:0" })
      .effect;
    expect(result).toEqual({
      _tag: "SucceededIncrement",
      commandId: "page:0",
      reply: { total: 2 },
      receipt: { stream: "Counter/one", version: 1 },
    });
    expect(Schema.is(Counter.Message)(result)).toBe(true);
    const replay = yield* Counter.Increment({ target, input: { amount: 2 }, commandId: "page:0" })
      .effect;
    expect(replay).toEqual(result);
  }).pipe(Effect.provide(Client)),
);

it.effect("keeps declared rejection fields", () =>
  Effect.gen(function* () {
    const result = yield* Counter.Increment({ target, input: { amount: 11 }, commandId: "page:1" })
      .effect;
    expect(result).toMatchObject({
      _tag: "FailedIncrement",
      commandId: "page:1",
      failure: { _tag: "Rejected", rejection: { _tag: "Limit", amount: 11 } },
    });
  }).pipe(Effect.provide(Client)),
);

it.effect("classifies a middleware refusal as Denied", () =>
  Effect.gen(function* () {
    const result = yield* Counter.Reset({ target, input: {}, commandId: "page:2" }).effect;
    expect(result).toMatchObject({
      _tag: "FailedReset",
      failure: { _tag: "Denied", error: { _tag: "Unauthenticated" } },
    });
  }).pipe(Effect.provide(Client)),
);

it.effect("keeps transport uncertainty and reads headers only during execution", () =>
  Effect.gen(function* () {
    const client = yield* CounterApi.Client;
    let calls = 0;
    const uncertain = Layer.succeed(CounterApi.Client, {
      ...client,
      Increment: () =>
        Effect.fail(
          new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({
              cause: "lost reply",
              message: "lost reply",
            }),
          }),
        ),
    });
    const command = Counter.Increment({ target, input: { amount: 1 }, commandId: "page:3" });
    expect(calls).toBe(0);
    const result = yield* command.effect.pipe(
      Effect.provide(uncertain),
      Effect.provideService(Foldkit.CommandHeaders, {
        get: () =>
          Effect.sync(() => {
            calls += 1;
            return { "x-mfa-code": "secret" };
          }),
      }),
    );
    expect(calls).toBe(1);
    expect(result).toMatchObject({ _tag: "FailedIncrement", failure: { _tag: "Unknown" } });
    expect(command.args).toEqual({ target, input: { amount: 1 }, commandId: "page:3" });
  }).pipe(Effect.provide(Client)),
);

it("allocates ids without changing the prior state", () => {
  const ids = Foldkit.CommandIds.make({ session: "page", sent: 0 });
  expect(Foldkit.next(ids)).toEqual({
    commandId: "page:0",
    commandIds: { session: "page", sent: 1 },
  });
  expect(ids.sent).toBe(0);
});
