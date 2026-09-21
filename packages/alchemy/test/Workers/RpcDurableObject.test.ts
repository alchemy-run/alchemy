import { bindEffectRpc } from "@/Workers/RpcDurableObject.ts";
import { expect, it } from "alchemy-test";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

class Invocation extends Context.Service<Invocation, string>()(
  "HttpRpcInvocation",
) {}
class Calls extends RpcGroup.make(
  Rpc.make("echo", {
    payload: { value: Schema.String },
    success: Schema.String,
  }),
  Rpc.make("watch", { success: Schema.Number, stream: true }),
) {}

const harness = Effect.gen(function* () {
  const release = yield* Deferred.make<void>();
  const observations: {
    invocation: string;
    scope: Scope.Scope | undefined;
    closed: boolean;
  }[] = [];
  const namespace = bindEffectRpc(
    {
      getByName: (_name: string) => {
        const context = Fiber.getCurrent()!.context;
        const observation = {
          invocation: Context.getUnsafe(context, Invocation),
          scope: undefined as Scope.Scope | undefined,
          closed: false,
        };
        observations.push(observation);
        return {
          fetch: (request) =>
            Effect.gen(function* () {
              yield* Effect.withFiber((fiber) =>
                Effect.sync(() => {
                  observation.scope = Context.getUnsafe(
                    fiber.context,
                    Scope.Scope,
                  );
                  expect(Context.getUnsafe(fiber.context, Invocation)).toBe(
                    observation.invocation,
                  );
                }),
              );
              if (request.body._tag !== "Uint8Array")
                return yield* Effect.die("Expected encoded HTTP RPC request");
              const body = request.body.body;
              const message = yield* Effect.sync(
                () =>
                  JSON.parse(new TextDecoder().decode(body)) as {
                    id: string;
                    tag: string;
                    payload: { value: string };
                  },
              );
              const encode = (value: unknown) =>
                new TextEncoder().encode(`${JSON.stringify(value)}\n`);
              const exit = {
                _tag: "Exit",
                requestId: message.id,
                exit: { _tag: "Success", value: message.payload?.value },
              };
              const stream = (
                message.tag === "watch"
                  ? Stream.concat(
                      Stream.make({
                        _tag: "Chunk",
                        requestId: message.id,
                        values: [1],
                      }),
                      Stream.fromEffect(
                        Deferred.await(release).pipe(
                          Effect.as({
                            ...exit,
                            exit: { _tag: "Success", value: undefined },
                          }),
                        ),
                      ),
                    )
                  : Stream.make(exit)
              ).pipe(
                Stream.map(encode),
                Stream.ensuring(
                  Effect.sync(() => {
                    observation.closed = true;
                  }),
                ),
              );
              const response = yield* Effect.sync(() =>
                HttpClientResponse.fromWeb(request, new Response()),
              );
              return new Proxy(response, {
                get: (target, property) =>
                  property === "stream"
                    ? stream
                    : Reflect.get(target, property),
              });
            }),
        };
      },
    },
    Calls,
  );
  return { namespace, observations, release };
});

it.effect(
  "HTTP namespace clients survive their acquisition scope and resolve a fresh native stub per unary invocation",
  () =>
    Effect.gen(function* () {
      const { namespace, observations } = yield* harness;
      const client = yield* namespace.getByName("room").pipe(Effect.scoped);
      expect(observations).toEqual([]);
      expect(
        yield* client
          .echo({ value: "first" })
          .pipe(Effect.provideService(Invocation, "one")),
      ).toBe("first");
      expect(
        yield* client
          .echo({ value: "second" })
          .pipe(Effect.provideService(Invocation, "two")),
      ).toBe("second");
      expect(observations.map((value) => value.invocation)).toEqual([
        "one",
        "two",
      ]);
      expect(observations.every((value) => value.closed)).toBe(true);
      expect(observations[0]!.scope).not.toBe(observations[1]!.scope);
    }),
);

it.effect(
  "HTTP streams acquire at consumption and release their client on interruption",
  () =>
    Effect.gen(function* () {
      const { namespace, observations } = yield* harness;
      const client = yield* namespace.getByName("room").pipe(Effect.scoped);
      const stream = client.watch();
      expect(observations).toEqual([]);
      expect(
        yield* stream.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.provideService(Invocation, "stream"),
        ),
      ).toEqual([1]);
      expect(
        observations.map((value) => ({
          invocation: value.invocation,
          closed: value.closed,
        })),
      ).toEqual([{ invocation: "stream", closed: true }]);
    }),
);

it.effect(
  "HTTP asQueue subscriptions retain the caller scope until the consumer releases it",
  () =>
    Effect.gen(function* () {
      const { namespace, observations } = yield* harness;
      const client = yield* namespace.getByName("room").pipe(Effect.scoped);
      yield* Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const queue = yield* client.watch(undefined, { asQueue: true });
        expect(yield* Queue.take(queue)).toBe(1);
        expect(observations[0]!.closed).toBe(false);
        expect(observations[0]!.scope).toBe(scope);
      }).pipe(Effect.scoped, Effect.provideService(Invocation, "queue"));
      expect(observations[0]!.closed).toBe(true);
    }),
);
