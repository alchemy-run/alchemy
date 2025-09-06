import type { MessageBatch } from "@cloudflare/workers-types";
import type { Effect } from "effect/Effect";
import type { Instance } from "./ctor.ts";
import type { Queue } from "./queue.ts";
import type { Resource } from "./resource.ts";
import type { Fetch, Worker as _Worker } from "./worker.bindings.ts";

export * as Worker from "./worker.bindings.ts";

// TODO
type HttpError = never;

export type Worker<ID extends string = any> = {
  type: "Worker";
  id: ID;
  new (
    _: never,
  ): {
    type: "Worker";
    id: ID;
  };
  fetch<Self>(
    this: Self,
    request: Request,
  ): Effect<Response, HttpError, Fetch<Instance<Self>>>;
  serve<Self extends Resource, Err = never, Req = never>(
    this: Self,
    fetch: (request: Request) => Effect<Response, Err, Req>,
  ): _Worker<Instance<Self>, Err, Req>;
  consume<Self extends Resource, Q extends Queue, Req = never>(
    this: Self,
    queue: Q,
    fn: (batch: MessageBatch<Q["message"]>) => Effect<void, never, Req>,
  ): _Worker<Instance<Self>, never, Req | Queue.Consume<Instance<Q>>>;
};
