import * as Effect from "effect/Effect";
import { Bucket } from "../bucket.ts";
import { alchemy } from "../index.ts";
import { Queue } from "../queue.ts";
import { Worker } from "../worker.ts";
import { Messages } from "./messages.ts";

// 1. resource declarations
export class Videos extends Bucket.Resource("videos") {}
export class Storage extends Bucket.Resource("storage") {}
export class Backend extends Worker.Resource("backend") {}
export class Backend2 extends Worker.Resource("backend2") {}
export class Api extends Worker.Resource("api") {}

// 2. business logic
export const backend = Backend.serve(
  Effect.fn(function* (request) {
    yield* Bucket.put(Videos, request.url, "");
    return new Response("");
  }),
);

export const backend2 = Backend2.consume(
  Messages,
  Effect.fn(function* (batch) {
    for (const message of batch.messages) {
      yield* Worker.fetch(Backend, "http://example.com");
      yield* Backend.fetch(new Request("https://example.com"));
      // yield* Bucket.get(Videos, message.body.key);
      // yield* Videos.put(message.body.key, message.body.value);
      message.ack();
    }
  }),
);

const backendStack = alchemy.stack(
  backend.bind(alchemy.policy(Bucket.Put(Videos))),
  backend2.bind(alchemy.policy(Worker.Fetch(Backend), Queue.Consume(Messages))),
);

await backendStack.pipe(Effect.runPromise);

type AST = {
  [id: string]: any;
};

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
