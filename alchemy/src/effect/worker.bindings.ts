import type { MessageBatch, Service } from "@cloudflare/workers-types";
import type { Effect } from "effect/Effect";
import type { Simplify } from "./alchemy.ts";
import type { Bound } from "./bind.ts";
import { binding } from "./binding.ts";
import type { Instance } from "./ctor.ts";
import type { Allow, Policy, Statement } from "./policy.ts";
import type { Queue } from "./queue.ts";
import type { Worker as _Worker } from "./worker.ts";

const Binding = binding<Service>();

export type Resource<ID extends string> = _Worker<ID>;

export declare function Resource<ID extends string>(id: ID): _Worker<ID>;

export type Fetch<W> = Allow<W, "Worker::Fetch">;
export declare function Fetch<W>(worker: W): Policy<Fetch<Instance<W>>>;

export type Worker<Self extends { id: string }, Err, Req> = Effect<
  Instance<Self>,
  never,
  Policy.Normalize<Req>
> & {
  consume<Q extends Queue, Req2 = never>(
    queue: Q,
    fn: (batch: MessageBatch<Q["message"]>) => Effect<void, never, Req2>,
  ): Effect<Instance<Q>, Err, Policy.Normalize<Req | Req2 | Queue.Consume<Q>>>;

  consume<Q, Req2 = never>(
    consumer: Queue.Consumer<Q, Req2>,
  ): Worker<Self, Err, Policy.Normalize<Req | Req2 | Queue.Consume<Q>>>;

  bind<Q>(
    this: Q,
    policy: Policy<
      Extract<Req, Policy>["statements"][number] | Extract<Req, Statement>
    >,
  ): Effect<
    Simplify<
      {
        [id in Self["id"]]: Bound<
          Self,
          Extract<Req, Policy>["statements"][number] | Extract<Req, Statement>
        >;
      } & {
        [id in Policy.Resources<Policy.Collect<Req>>["id"]]: Extract<
          Policy.Resources<Policy.Collect<Req>>,
          { id: id }
        >;
      }
    >
  >;
};

export const fetch = <W extends _Worker>(
  worker: W,
  ...parameters: Parameters<Service["fetch"]>
) => Binding.fetch<Fetch<Instance<W>>>()(worker, ...parameters);
