import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

// TODO(sam): are there errors?
export type SendMessageError = never;
// a declared Queue at runtime
export type Queue<ID extends string = string, Msg = any> = {
  id: ID;
  send(
    message: Msg,
  ): Effect.Effect<void, SendMessageError, Queue.Send<ID, Msg>>;
  sendBatch(
    ...message: Msg[]
  ): Effect.Effect<void, SendMessageError, Queue.SendBatch<ID, Msg>>;
  /** @internal */
  Batch: Queue.Batch<Msg>;
  forBatch<Req = never>(
    fn: (batch: Queue.Batch<Msg>) => Effect.Effect<void, never, Req>,
  ): <T, E, R>(
    effect: Effect.Effect<T, E, R>,
  ) => Effect.Effect<
    T & {
      queue(batch: Queue.Batch<Msg>): Effect.Effect<void, never, never>;
    },
    never,
    MergeReq<Policy<Queue.Consume<ID, Msg>>, Req>
  >;
};

// TODO(sam): is sthere a cleaner way to do this?
type MergeReq<A, B> =
  | Policy<Extract<A, Policy>["statements"] | Extract<B, Policy>["statements"]>
  | Exclude<A, Policy>
  | Exclude<B, Policy>;

export declare namespace Queue {
  // type of a batch of messages at runtime
  export type Batch<Msg> = {
    messages: Msg[];
    ackAll: () => Effect.Effect<void, never, never>;
  };

  export type Consume<ID extends string, Msg> = Allow<
    ID,
    "Queue::Consume",
    { msg: Msg }
  >;
  export function Consume<ID extends string, Msg>(
    queue: Queue<ID, Msg>,
    // fn: (batch: Queue.Batch<Msg>) => Effect.Effect<void, never, never>,
  ): Policy<Consume<ID, Msg>>;

  // policy specification
  export type Send<ID extends string, Msg> = Allow<
    ID,
    "Queue::Send",
    { message: Msg }
  >;
  // provide Infrastructure policy
  export function Send<ID extends string, Msg>(
    queue: Queue<ID, Msg>,
  ): Policy<Send<ID, Msg>>;
  // provide Runtime client
  export function send<ID extends string, Msg>(
    queue: Queue<ID, Msg>,
  ): Layer.Layer<Send<ID, Msg>>;

  // policy specification
  export type SendBatch<ID extends string, Msg> = Allow<
    ID,
    "Queue::SendBatch",
    { message: Msg[] }
  >;
  // provide Infrastructure policy
  export function SendBatch<ID extends string, Msg>(
    queue: Queue<ID, Msg>,
  ): Policy<SendBatch<ID, Msg>>;

  // provide Runtime client
  export function sendBatch<ID extends string, Msg>(
    queue: Queue<ID, Msg>,
  ): Layer.Layer<SendBatch<ID, Msg>>;
}

export function Queue<ID extends string>(id: ID) {
  return <T>(): Queue<ID, T> => ({
    id,
    // TODO
    send: (message: T) => Effect.succeed(void 0),
    // TODO
    sendBatch: (...message: T[]) => Effect.succeed(void 0),
    get Batch(): never {
      throw new Error("Cannot access phantom property, Batch");
    },
    // TODO
    forBatch: <Req = never>(
      fn: (batch: Queue.Batch<T>) => Effect.Effect<void, never, Req>,
    ) => Effect.succeed(void 0) as any,
  });
}

export type Bucket<ID extends string> = {
  get<const Key extends string = string>(
    key: Key,
  ): Effect.Effect<string | undefined, never, Policy<Bucket.Get<ID, Key>>>;
  put(
    key: string,
    value: string,
  ): Effect.Effect<void, never, Policy<Bucket.Put<ID, string>>>;
};

export declare function Bucket<ID extends string>(id: ID): Bucket<ID>;

export declare namespace Bucket {
  export type Get<ID extends string, Key extends string> = Allow<
    ID,
    "Bucket::Get",
    { key: Key }
  >;
  export function Get<ID extends string, const Key extends string>(
    bucket: Bucket<ID>,
    key?: Key,
  ): Policy<Get<ID, Key>>;
  export function get<ID extends string, Key extends string>(
    bucket: Bucket<ID>,
    key?: Key,
  ): Layer.Layer<Get<ID, Key>>;

  export type Put<ID extends string, Key extends string> = Allow<
    ID,
    "Bucket::Put",
    { key: Key }
  >;
  export function Put<ID extends string, Key extends string>(
    bucket: Bucket<ID>,
  ): Policy<Put<ID, Key>>;
}

export type KVNamespace<
  ID extends string,
  Key extends string,
  Value extends string,
> = {
  get(
    key: Key,
  ): Effect.Effect<
    Value | undefined,
    never,
    Policy<KVNamespace.Get<ID, Key, Value>>
  >;
  put(
    key: Key,
    value: Value,
  ): Effect.Effect<void, never, Policy<KVNamespace.Put<ID, Key, Value>>>;
};
export function KVNamespace<ID extends string>(id: ID) {
  return <
    Key extends string = string,
    Value extends string = string,
  >(): KVNamespace<ID, Key, Value> => ({
    get: (key: Key) => Effect.succeed(undefined),
    put: (key: Key, value: Value) => Effect.succeed(void 0),
  });
}
export declare namespace KVNamespace {
  export type Get<
    ID extends string,
    Key extends string,
    Value extends string,
  > = Allow<ID, "KV::Get", { key: Key; value: Value }>;
  export function Get<
    ID extends string,
    Key extends string,
    Value extends string,
  >(kv: KVNamespace<ID, Key, Value>): Policy<Get<ID, Key, Value>>;
  export function get<
    ID extends string,
    Key extends string,
    Value extends string,
  >(kv: KVNamespace<ID, Key, Value>): Layer.Layer<Get<ID, Key, Value>>;

  export type Put<
    ID extends string,
    Key extends string,
    Value extends string,
  > = Allow<ID, "KV::Put", { key: Key; value: Value }>;
  export function Put<
    ID extends string,
    Key extends string,
    Value extends string,
  >(kv: KVNamespace<ID, Key, Value>): Policy<Put<ID, Key, Value>>;
  export function put<
    ID extends string,
    Key extends string,
    Value extends string,
  >(kv: KVNamespace<ID, Key, Value>): Layer.Layer<Put<ID, Key, Value>>;
}
export interface Allow<
  ID extends string,
  Action extends string,
  Condition = any,
> {
  effect: "Allow";
  action: Action;
  resource: ID;
  condition?: Condition;
}

export interface Deny<
  ID extends string,
  Action extends string,
  Condition = any,
> {
  effect: "Deny";
  action: Action;
  resource: ID;
  condition?: Condition;
}

export type Statement<
  ID extends string = string,
  Action extends string = string,
> = Allow<ID, Action> | Deny<ID, Action>;

// A policy is invariant over its allowed actions
export interface Policy<in out Statements extends Statement = any> {
  readonly statements: Statements;
}

export type Handler = {
  fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response>;
};

export type Fetch<Req = never> = Effect.Effect<
  {
    fetch(request: Request): Effect.Effect<Response, never, Req>;
  },
  never,
  Req
>;
export declare function Fetch<Req = never>(
  fetch: (request: Request) => Effect.Effect<Response, never, Req>,
): Fetch<Req>;

export declare function Worker<ID extends string, T, Req = never>(
  id: ID,
  effect: Effect.Effect<T, never, Req>,
): Effect.Effect<Worker<ID, T>, never, Req>;
export declare function Worker<ID extends string>(
  id: ID,
): <T, Req = never>(
  effect: Effect.Effect<T, never, Req>,
) => Effect.Effect<Worker<ID, T>, never, Req>;

export type Worker<ID extends string, Exports> = {
  id: ID;
  exports: Exports;
};

type Bind<S extends Statement> = <
  E extends Effect.Effect<any, never, Policy<S>>,
>(
  effect: E,
) => Effect.Effect<Effect.Effect.Success<E>, never, never>;

declare namespace alchemy {
  function bind<S extends readonly Policy[]>(
    ...actions: S
  ): Bind<S[number]["statements"]>;

  function runtime(
    meta: ImportMeta,
  ): <E extends Effect.Effect<Handler, any, never>>(worker: E) => Handler;
}

// THE HOLY TRINITY 🔱

// 1. business logic & contract
const bucket = Bucket("bucket");

const queue = Queue("queue")<{
  key: string;
  value: string;
}>();

// compose a fetch (http) handler and a queue consumer into a single Worker
const backend = Fetch((request: Request) =>
  Effect.gen(function* () {
    return new Response(yield* bucket.get(request.url));
  }),
).pipe(
  queue.forBatch(
    Effect.fn(function* (batch) {
      for (const message of batch.messages) {
        yield* bucket.put(message.key, message.value);
      }
    }),
  ),
  Worker("backend"),
);

// 2. materialize physical resourcew with least privilege policy
const deployment = backend.pipe(
  alchemy.bind(Queue.Consume(queue), Bucket.Put(bucket)),
);
await Effect.runPromise(deployment);

// // alternative syntax
// const backend2 = Worker(
//   "worker",
//   Fetch((request: Request) =>
//     Effect.gen(function* () {
//       return new Response(yield* bucket.get(request.url));
//     }),
//   ).pipe(
//     queue.forBatch(
//       Effect.fn(function* (batch) {
//         for (const message of batch.messages) {
//           yield* bucket.put(message.key, message.value);
//         }
//       }),
//     ),
//   ),
// );
