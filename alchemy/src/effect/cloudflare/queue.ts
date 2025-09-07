import type { MessageBatch } from "@cloudflare/workers-types";
import type * as Effect from "effect/Effect";
import type { Queue as QueueResource } from "../../cloudflare/queue.ts";
import type { Instance } from "../ctor.ts";
import type { Policy } from "../policy.ts";
import type { Consumer, Send, SendBatch } from "./queue.bindings.ts";

export * as Queue from "./queue.bindings.ts";

// TODO(sam): are there errors?
export type SendMessageError = never;

// a declared Queue at runtime
export type Queue<ID extends string = string, Msg = any> = {
  type: "Queue";
  id: ID;
  message: Msg;
  Batch: MessageBatch<Msg>;
  new (_: never): QueueResource<ID, Msg>;
  send<Q>(
    this: Q,
    message: Msg,
  ): Effect.Effect<void, SendMessageError, Policy<Send<Instance<Q>>>>;
  sendBatch<Q>(
    this: Q,
    ...message: Msg[]
  ): Effect.Effect<void, SendMessageError, Policy<SendBatch<Instance<Q>>>>;
  consume<Q, Req = never>(
    this: Q,
    fn: (batch: MessageBatch<Msg>) => Effect.Effect<void, never, Req>,
  ): Consumer<Instance<Q>, Req>;
};
