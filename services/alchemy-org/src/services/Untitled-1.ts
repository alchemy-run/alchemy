// @ts-nocheck

export class Counter extends Alchemy.DurableObject<
  Counter,
  {
    increment(): Effect.Effect<number>;
    get(): Effect.Effect<number>;
  }
>()("Counter") {}

export const CounterLive = Counter.make(
  Effect.gen(function* () {
    const state = yield* Alchemy.DurableObjectState;

    return Effect.gen(function* () {
      return {
        increment: () => state.put(state.get() + 1),
        get: () => Effect.sync(() => state.get()),
      };
    });
  }),
);

export class MyWorker extends Alchemy.Worker<MyWorker>()("MyWorker") {}

export const MyWorkerLive = MyWorker.make(
  Effect.gen(function* () {
    const counters = yield* Counter;

    return {
      fetch: Effect.gen(function* () {
        const req = yield* HttpServerRequest;

        const name = new URL(req.url, "http://w").pathname.slice(1);

        const value = yield* counters
          .getByName(name)
          .increment()
          .pipe(Effect.orDie);

        return yield* HttpServerResponse.json({ value });
      }),
    };
  }),
).pipe(Layer.provide(CounterLive));

// Worker.ts
export default Cloudflare.Worker(MyWorkerLive, { main: import.meta.url });
export default MyWorkerLive.pipe(Cloudflare.Worker({ main: import.meta.url }));

// Celld.ts
export default Celld.Worker(MyWorkerLive, { main: import.meta.url });
export default MyWorkerLive.pipe(Celld.Worker({ main: import.meta.url }));

// Rivet
export default Rivet.Worker(MyWorkerLive, { main: import.meta.url });
export default MyWorkerLive.pipe(Rivet.Worker({ main: import.meta.url }));
