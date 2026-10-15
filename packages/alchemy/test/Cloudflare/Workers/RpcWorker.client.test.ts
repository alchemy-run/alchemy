import { describe, expect, it } from "alchemy-test";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpEffect from "effect/http/HttpEffect";
import * as Layer from "effect/Layer";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import { RpcWorker, type RpcWorkerYieldable } from "@/Cloudflare/Workers/RpcWorker";
import { Worker, WorkerEnvironment } from "@/Cloudflare/Workers/Worker";
import { Self } from "@/Self";

class RequestOwner extends Context.Service<RequestOwner, string>()("RpcWorkerTest.Owner") {}
class ClientAuth extends RpcMiddleware.Service<ClientAuth>()("RpcWorkerTest.Auth") {}
class Rejected extends Schema.TaggedError<Rejected>()("Rejected", { message: Schema.String }) {}

const Group = RpcGroup.make(
  Rpc.make("Unary", {
    payload: { value: Schema.Number },
    success: Schema.Struct({ value: Schema.Number, owner: Schema.String, header: Schema.String }),
    error: Rejected,
  }).middleware(ClientAuth),
  Rpc.make("Fail", { payload: {}, error: Rejected, success: Schema.Never }),
  Rpc.make("Wait", { payload: {}, success: Schema.Void }),
);

const clientAuth = RpcMiddleware.layerClient(ClientAuth, ({ request, next }) =>
  Effect.flatMap(RequestOwner, (owner) =>
    next({ ...request, headers: { ...request.headers, authorization: owner } }),
  ),
);

const target = Object.assign(
  Effect.succeed({ LogicalId: "Target", workerName: "rpc-target" } as unknown as Worker),
  { [Symbol.for("alchemy.RpcWorker.schema")]: Group },
) as unknown as RpcWorkerYieldable<never, RpcGroup.Rpcs<typeof Group>>;

// Resource constructors expose Worker as the requirement but look up its Self
// service at runtime. Provide that exact key with the constructor's identity.
const WorkerHost = Self<Worker>("Cloudflare.Worker") as unknown as Context.Key<Worker, Worker>;
const bindClient = RpcWorker.bind(target).pipe(
  Effect.provideService(WorkerHost, {
    bind: () => () => Effect.void,
  } as unknown as Worker),
);

const makeTarget = (owner: string) => {
  const handlers = Group.toLayer({
    Unary: ({ value }, { headers }) =>
      headers.authorization === owner
        ? Effect.succeed({ value, owner, header: headers["x-request"] ?? "" })
        : Effect.fail(new Rejected({ message: "wrong request owner" })),
    Fail: () => Effect.fail(new Rejected({ message: owner })),
    Wait: () => Effect.never,
  });
  const run = HttpEffect.toWebHandler(
    Effect.gen(function* () {
      const http = yield* RpcServer.toHttpEffect(Group).pipe(
        Effect.provide(
          Layer.mergeAll(
            handlers,
            RpcSerialization.layerNdjson,
            Layer.succeed(ClientAuth, (effect) => effect),
          ),
        ),
      );
      return yield* http;
    }),
  );
  return { fetch: (request: Request) => run(request) };
};

describe("RpcWorker client dispatch", { tags: ["unit", "local"] }, () => {
  it.effect(
    "keeps bindings, client auth, and call headers isolated across concurrent requests",
    () =>
      Effect.gen(function* () {
        const client = yield* bindClient;
        const results = yield* Effect.forEach(
          Array.from({ length: 20 }, (_, value) => ({ value, owner: `owner-${value}` })),
          ({ value, owner }) =>
            client
              .Unary({ value }, { headers: { "x-request": owner } })
              .pipe(
                Effect.provide(clientAuth),
                Effect.provideService(RequestOwner, owner),
                Effect.provideService(WorkerEnvironment, { Target: makeTarget(owner) }),
              ),
          { concurrency: 4 },
        );
        expect(results).toEqual(
          Array.from({ length: 20 }, (_, value) => ({
            value,
            owner: `owner-${value}`,
            header: `owner-${value}`,
          })),
        );
      }),
  );

  it.effect("preserves typed remote failures and discard options", () =>
    Effect.gen(function* () {
      const client = yield* bindClient;
      const failure = yield* client.Fail({}).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(Rejected);
      expect(failure.message).toBe("owner");
      const discarded = yield* client.Unary({ value: 1 }, { discard: true });
      expect(discarded).toBeUndefined();
    }).pipe(
      Effect.provide(clientAuth),
      Effect.provideService(RequestOwner, "owner"),
      Effect.provideService(WorkerEnvironment, { Target: makeTarget("owner") }),
    ),
  );

  it.effect("interrupts the request-owned fetch when its caller is cancelled", () =>
    Effect.gen(function* () {
      const client = yield* bindClient;
      const started = yield* Deferred.make<void>();
      let aborted = false;
      const fetch = (request: Request) => {
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          });
          Deferred.doneUnsafe(started, Effect.void);
        });
      };
      const fiber = yield* client
        .Wait({})
        .pipe(Effect.provideService(WorkerEnvironment, { Target: { fetch } }), Effect.forkChild);
      // The child must reach fetch before interruption, otherwise there is no I/O to cancel.
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(aborted).toBe(true);
    }),
  );
});
