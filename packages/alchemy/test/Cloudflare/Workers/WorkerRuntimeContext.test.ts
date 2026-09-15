import { toRpcAsync } from "@/Cloudflare/Workers/RpcAsync.ts";
import { makeWorkerRuntimeContext } from "@/Cloudflare/Workers/WorkerRuntimeContext.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

const dispatch = async (
  exports: Record<string, any>,
  type: string,
  input: unknown,
) => {
  const [program, services] = exports.default[type](
    input,
    {},
    {} as ExecutionContext,
  );
  await Effect.runPromise(program.pipe(Effect.provide(services)));
};

describe("WorkerRuntimeContext", () => {
  it("dispatches an event to every listener for that event type", async () => {
    const ctx = makeWorkerRuntimeContext("test-worker");
    const observed: string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* ctx.listen((event) => {
          if (event.type !== "queue") return;
          return Effect.sync(() => {
            observed.push("first");
          });
        });
        yield* ctx.listen((event) => {
          if (event.type !== "queue") return;
          return Effect.sync(() => {
            observed.push("second");
          });
        });
      }),
    );

    const exports = await Effect.runPromise(ctx.exports);
    await dispatch(exports, "queue", { queue: "queue-a", messages: [] });

    expect(observed).toEqual(["first", "second"]);
  });

  it("registers ExportedHandler methods from the serve shape as listeners", async () => {
    const ctx = makeWorkerRuntimeContext("shape-handlers");
    const observed: string[] = [];

    await Effect.runPromise(
      ctx.serve(Effect.succeed(HttpServerResponse.text("ok")), {
        shape: {
          fetch: Effect.succeed(HttpServerResponse.text("ok")),
          scheduled: (controller: { cron: string }) =>
            Effect.sync(() => {
              observed.push(`scheduled:${controller.cron}`);
            }),
          queue: (batch: { queue: string }) =>
            Effect.sync(() => {
              observed.push(`queue:${batch.queue}`);
            }),
          email: (message: { from: string }) =>
            Effect.sync(() => {
              observed.push(`email:${message.from}`);
            }),
          greet: (name: string) => Effect.succeed(`hello ${name}`),
        },
      }),
    );

    const exports = await Effect.runPromise(ctx.exports);
    await dispatch(exports, "scheduled", { cron: "* * * * *" });
    await dispatch(exports, "queue", { queue: "inbox", messages: [] });
    await dispatch(exports, "email", { from: "a@example.com" });

    expect(observed).toEqual([
      "scheduled:* * * * *",
      "queue:inbox",
      "email:a@example.com",
    ]);
  });

  it("omits ExportedHandler methods from the RPC shape captured by serve()", async () => {
    const ctx = makeWorkerRuntimeContext("rpc-shape");

    await Effect.runPromise(
      ctx.serve(Effect.succeed(HttpServerResponse.text("ok")), {
        shape: {
          fetch: Effect.succeed(HttpServerResponse.text("ok")),
          scheduled: () => Effect.void,
          email: () => Effect.void,
          queue: () => Effect.void,
          greet: (name: string) => Effect.succeed(`hello ${name}`),
        },
      }),
    );

    const shape = ctx.shape();
    expect(shape.fetch).toBeUndefined();
    expect(shape.scheduled).toBeUndefined();
    expect(shape.email).toBeUndefined();
    expect(shape.queue).toBeUndefined();
    expect(typeof shape.greet).toBe("function");
    expect(await Effect.runPromise(shape.greet("sam"))).toBe("hello sam");
  });
});

describe("toRpcAsync", () => {
  it("does not wrap ExportedHandler methods as RPC", async () => {
    const scheduled = async () => "from-native-scheduled";
    const stub = {
      fetch: async () => new Response("ok"),
      connect: () => undefined,
      scheduled,
      greet: async () => ({
        _tag: "~alchemy/rpc/error" as const,
        error: { message: "rpc-only" },
      }),
    };

    const rpc = toRpcAsync<{
      greet: () => Effect.Effect<never, { message: string }>;
      scheduled: () => Effect.Effect<string>;
    }>(stub);

    // Handler methods pass through to the underlying binding (no envelope
    // decode). RPC methods still unwrap envelopes.
    expect(
      await (
        rpc as unknown as { scheduled: () => Promise<string> }
      ).scheduled(),
    ).toBe("from-native-scheduled");
    await expect(rpc.greet()).rejects.toThrow("rpc-only");
  });
});
