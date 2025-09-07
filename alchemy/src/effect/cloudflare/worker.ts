import type { MessageBatch } from "@cloudflare/workers-types";
import type { Effect } from "effect/Effect";
import type { Worker as WorkerResource } from "../../cloudflare/worker.ts";
import type { Ctor, Instance } from "../ctor.ts";
import type { Queue } from "./queue.ts";
import type { Fetch, Worker as _Worker } from "./worker.bindings.ts";

export * as Worker from "./worker.bindings.ts";

// TODO
type HttpError = never;

export type Worker<ID extends string = any> = {
  type: "Worker";
  id: ID;
  new (_: never): WorkerResource<ID>;
  fetch<Self>(
    this: Self,
    request: Request,
  ): Effect<Response, HttpError, Fetch<Instance<Self>>>;
  serve<Self extends Ctor<WorkerResource<ID>>, Err = never, Req = never>(
    this: Self,
    fetch: (request: Request) => Effect<Response, Err, Req>,
  ): _Worker<Instance<Self>, Err, Req>;
  consume<Self extends Ctor<WorkerResource<ID>>, Q extends Queue, Req = never>(
    this: Self,
    queue: Q,
    fn: (batch: MessageBatch<Q["message"]>) => Effect<void, never, Req>,
  ): _Worker<Instance<Self>, never, Req | Queue.Consume<Instance<Q>>>;
};
