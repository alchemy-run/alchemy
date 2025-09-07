import type * as Effect from "effect/Effect";
import type { Schema } from "effect/Schema";
import type { Instance } from "../ctor.ts";
import type { Allow, Policy } from "../policy.ts";
import type { Queue } from "./queue.ts";

export type Resource<ID extends string, Message = any> = Queue<ID, Message>;

export declare function Resource<ID extends string>(
  id: ID,
): <Msg>() => Queue<ID, Msg>;
export declare function Resource<ID extends string, Msg>(
  id: ID,
  options: {
    schema: Schema<Msg>;
  },
): Queue<ID, Msg>;

export type Consumer<Q, Req> = Effect.Effect<
  void,
  never,
  Policy.Normalize<Req | Policy<Consume<Q>>>
>;

export type Consume<Q> = Allow<Q, "Queue::Consume", {}>;
export declare function Consume<Q extends Queue>(
  queue: Q,
): Policy<Consume<Instance<Q>>>;

// policy specification
export type Send<Q> = Allow<Q, "Queue::Send">;
// provide Infrastructure policy
export declare function Send<Q>(queue: Q): Policy<Send<Q>>;

// policy specification
export type SendBatch<Q> = Allow<Q, "Queue::SendBatch">;
// provide Infrastructure policy
export declare function SendBatch<Q>(queue: Q): Policy<SendBatch<Q>>;
