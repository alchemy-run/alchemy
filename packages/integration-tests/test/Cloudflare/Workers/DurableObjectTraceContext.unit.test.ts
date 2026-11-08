import * as Cloudflare from "@alchemy.run/cloudflare";
import { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import { WorkerEnvironment } from "@alchemy.run/cloudflare/Workers/WorkerRuntime";
import { describe, expect, it } from "@alchemy.run/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

class Echo extends Cloudflare.DurableObject<
  Echo,
  { received: (...args: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<unknown>> }
>()("Echo") {}

// Worker resolves its host through the resource's Self key. Binding only
// registers the namespace with the host, which this test doesn't deploy.
const WorkerHost = Context.Service<Worker, never>(Worker.Self.key);

const host = {
  bind: () => () => Effect.void,
  durableObjectNamespaces: { pipe: () => undefined },
} as never;

// The object in the other script echoes exactly the arguments it received.
const env = {
  Echo: { getByName: () => ({ received: (...args: unknown[]) => Promise.resolve(args) }) },
};

const callFromOtherScript = (options?: Cloudflare.DurableObjectFromOptions) =>
  Effect.gen(function* () {
    const echo = yield* Echo.from("echo-host", options);
    const caller = yield* Effect.currentSpan;
    const args = yield* echo.getByName("echo").received("a", "b");
    return { args, traceId: caller.traceId, spanId: caller.spanId };
  }).pipe(
    Effect.withSpan("caller"),
    Effect.provideService(WorkerHost, host),
    Effect.provideService(WorkerEnvironment, env),
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
    ),
  );

describe(
  "Durable Object binding from another script",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  () => {
    it.effect("sends only the caller's arguments by default", () =>
      Effect.gen(function* () {
        const { args } = yield* callFromOtherScript();
        expect(args).toEqual(["a", "b"]);
      }),
    );

    it.effect("appends the caller's traceparent when it opts in with traceContext", () =>
      Effect.gen(function* () {
        const { args, traceId, spanId } = yield* callFromOtherScript({ traceContext: true });
        expect(args).toEqual(["a", "b", { "~alchemy/traceparent": `00-${traceId}-${spanId}-01` }]);
      }),
    );
  },
);
