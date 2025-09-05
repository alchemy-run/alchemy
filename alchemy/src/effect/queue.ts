import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { Instance } from "./ctor.ts";
import type { Allow, Policy } from "./policy.ts";

// TODO(sam): are there errors?
export type SendMessageError = never;

// a declared Queue at runtime
export type Queue<ID extends string = string, Msg = any> = {
  type: "Queue";
  id: ID;
  send<Q>(
    this: Q,
    message: Msg,
  ): Effect.Effect<void, SendMessageError, Policy<Queue.Send<Instance<Q>>>>;
  sendBatch<Q>(
    this: Q,
    ...message: Msg[]
  ): Effect.Effect<
    void,
    SendMessageError,
    Policy<Queue.SendBatch<Instance<Q>>>
  >;
  consume<Q, Req = never>(
    this: Q,
    fn: (batch: Queue.Batch<Msg>) => Effect.Effect<void, never, Req>,
  ): Queue.Consumer<Instance<Q>, Policy.Flatten<Req>>;
  new (
    _: never,
  ): {
    type: "Queue";
    id: ID;
  };
};

export declare function Queue<ID extends string>(id: ID): <T>() => Queue<ID, T>;
export declare function Queue<ID extends string, T>(
  id: ID,
  options: {
    schema: Schema.Schema<T>;
  },
): Queue<ID, T>;

export declare namespace Queue {
  // type of a batch of messages at runtime
  export type Batch<Msg> = {
    messages: Msg[];
    ackAll: () => Effect.Effect<void, never, never>;
  };

  export type Consume<Q> = Allow<Q, "Queue::Consume", {}>;
  export function Consume<Q>(queue: Q): Policy<Consume<Q>>;

  export type Consumer<Q, R = never> = Effect.Effect<
    void,
    never,
    R | Consume<Q>
  >;

  // policy specification
  export type Send<Q> = Allow<Q, "Queue::Send">;
  // provide Infrastructure policy
  export function Send<Q>(queue: Q): Policy<Send<Q>>;

  // policy specification
  export type SendBatch<Q> = Allow<Q, "Queue::SendBatch">;
  // provide Infrastructure policy
  export function SendBatch<Q>(queue: Q): Policy<SendBatch<Q>>;
}
