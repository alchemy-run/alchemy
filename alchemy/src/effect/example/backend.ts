import * as Effect from "effect/Effect";
import { Bucket } from "../bucket.ts";
import { alchemy } from "../index.ts";
import { Queue } from "../queue.ts";
import { Worker } from "../worker.ts";
import { Messages } from "./messages.ts";

// 1. resource declarations
export class Videos extends Bucket.Resource("videos") {}
export class Storage extends Bucket.Resource("storage") {}
export class Worker1 extends Worker.Resource("worker1") {}
export class Worker2 extends Worker.Resource("worker2") {}
export class Api extends Worker.Resource("api") {}

// 2. business logic
export const worker1 = Worker1.serve(
  Effect.fn(function* (request) {
    yield* Bucket.put(Videos, request.url, "");
    return new Response("");
  }),
).consume(
  Messages,
  Effect.fn(function* (batch) {
    for (const message of batch.messages) {
      yield* Worker.fetch(Worker2, "http://example.com");
      yield* Worker1.fetch(new Request("https://example.com"));
      message.ack();
    }
  }),
);

export const worker2 = Worker2.consume(
  Messages,
  Effect.fn(function* (batch) {
    for (const message of batch.messages) {
      yield* Worker.fetch(Worker1, "http://example.com");
      yield* Worker1.fetch(new Request("https://example.com"));
      message.ack();
    }
  }),
);

const stack = alchemy.stack(
  "my-app",
  worker1.bind(
    alchemy.policy(
      Bucket.Put(Videos),
      Queue.Consume(Messages),
      Worker.Fetch(Worker2),
      Worker.Fetch(Worker1),
    ),
  ),
  worker2.bind(alchemy.policy(Worker.Fetch(Worker1), Queue.Consume(Messages))),
);

await stack.pipe(Effect.runPromise);

// Program <-> Infra
// Program <-> Runtime
// Program <-> UI

// Program -> Runnable
// (Program -> Infra) -> Runnable
// (Program -> Handler) -> Runnable
// (Program -> UI) -> Runnable

// Worker -> Handler

// Api -> Worker<Api, Bindings>

// type Stack<I, P> = {
//   [id: string]: T;
// };
// type DeployReq = never;
// type Infra<B> = I;

// declare function plan(
//   state: any,
// ): <B, P>(
//   effect: Effect.Effect<B, never, P>,
// ) => Effect.Effect<Stack<Infra<B>, P>, never, never>;

// const apiInfra = api.pipe(
//   bind(
//     Bucket.Get(Storage),
//     Bucket.Put(Storage),
//     Bucket.Put(Storage2),
//     Queue.Send(Messages),
//   ),
// );

// declare namespace Plan {
//   function all<T extends { id: string }[]>(
//     infras: T,
//   ): {
//     [id in T[number]["id"]]: any;
//   };
//   function approve(plan: any): void;
//   function yes(plan: any): void;
//   function lint(plan: any): void;
//   function materialize(plan: any): void;
// }
// type Plan = {
//   //
// };

// // 3. deploy infrastructure with least privilege policy
// await Plan.all([backendInfra, apiInfra]).pipe(
//   Effect.map(({ backend, api }) => ({
//     backend,
//     api,
//   })),
//   Plan.approve,
//   Plan.yes,
//   lint,
//   materialize,
//   Effect.runPromise,
// );

// // we need to derive a PLAN
// // we need to derive a UI
// // we need to execute the PLAN
// export const app = stack(backendInfra, apiInfra);
// // layers are stacks

// app.pipe(alchemy.plan);
// app.pipe(alchemy.deploy);
// app.pipe(alchemy.ui);

// // 4. provide layers to construct physical handler
// export default backend.pipe(
//   Layer.provide(
//     // these are tree-shakable clients for specific methods
//     Bucket.get(Storage),
//     Bucket.put(Storage),
//     Bucket.put(Storage2),
//   ),
// );
