import * as Effect from "effect/Effect";

export interface Binding<Resource extends string, Action extends string> {
  readonly resource: Resource;
  readonly action: Action;
}

// TODO(sam): are there errors?
export type SendMessageError = never;

export type Queue<Resource extends string, Msg> = {
  send(
    message: Msg,
  ): Effect.Effect<void, SendMessageError, Queue.Send<Resource, Msg>>;
  sendBatch(
    ...message: Msg[]
  ): Effect.Effect<void, SendMessageError, Queue.SendBatch<Resource, Msg>>;
};

export declare namespace Queue {
  // export interface Send<Resource extends string> extends Binding<Resource, "Queue::Send"> {}
  export type Send<Resource extends string, Msg> = Allow<
    Resource,
    "Queue::Send",
    { message: Msg }
  >;
  export function Send<Resource extends string, Msg>(
    queue: Queue<Resource, Msg>,
  ): Send<Resource, Msg>;
  export type SendBatch<Resource extends string, Msg> = Allow<
    Resource,
    "Queue::SendBatch",
    { message: Msg[] }
  >;
  export function SendBatch<Resource extends string, Msg>(
    queue: Queue<Resource, Msg>,
  ): SendBatch<Resource, Msg>;
}

export function Queue<Resource extends string>(id: Resource) {
  return <T>(): Queue<Resource, T> => ({
    send: (message: T) => Effect.succeed(void 0),
    sendBatch: (...message: T[]) => Effect.succeed(void 0),
  });
}

export type Bucket<Resource extends string> = {
  get<const Key extends string = string>(
    key: Key,
  ): Effect.Effect<string | undefined, never, Bucket.Get<Resource, Key>>;
  put(
    key: string,
    value: string,
  ): Effect.Effect<void, never, Bucket.Put<Resource, string>>;
};

export declare function Bucket<Resource extends string>(
  id: Resource,
): Bucket<Resource>;

export declare namespace Bucket {
  export type Get<Resource extends string, Key extends string> = Allow<
    Resource,
    "Bucket::Get",
    { key: Key }
  >;
  export function Get<Resource extends string, const Key extends string>(
    bucket: Bucket<Resource>,
    key?: Key,
  ): Get<Resource, Key>;
  export type Put<Resource extends string, Key extends string> = Allow<
    Resource,
    "Bucket::Put",
    { key: Key }
  >;
  export function Put<Resource extends string, Key extends string>(
    bucket: Bucket<Resource>,
  ): Put<Resource, Key>;
}

export type KVNamespace<
  Resource extends string,
  Key extends string,
  Value extends string,
> = {
  get(
    key: Key,
  ): Effect.Effect<
    Value | undefined,
    never,
    KVNamespace.Get<Resource, Key, Value>
  >;
  put(
    key: Key,
    value: Value,
  ): Effect.Effect<void, never, KVNamespace.Put<Resource, Key, Value>>;
};
export function KVNamespace<Resource extends string>(id: Resource) {
  return <
    Key extends string = string,
    Value extends string = string,
  >(): KVNamespace<Resource, Key, Value> => ({
    get: (key: Key) => Effect.succeed(undefined),
    put: (key: Key, value: Value) => Effect.succeed(void 0),
  });
}
export declare namespace KVNamespace {
  export type Get<
    Resource extends string,
    Key extends string,
    Value extends string,
  > = Allow<Resource, "KV::Get", { key: Key; value: Value }>;
  export function Get<
    Resource extends string,
    Key extends string,
    Value extends string,
  >(kv: KVNamespace<Resource, Key, Value>): Get<Resource, Key, Value>;
  export type Put<
    Resource extends string,
    Key extends string,
    Value extends string,
  > = Allow<Resource, "KV::Put", { key: Key; value: Value }>;
  export function Put<
    Resource extends string,
    Key extends string,
    Value extends string,
  >(kv: KVNamespace<Resource, Key, Value>): Put<Resource, Key, Value>;
}

const queue = Queue("queue")<string>();

const kv = KVNamespace("kv")();

type MinimalPolicy<E> = E extends Effect.Effect<any, any, infer S>
  ? Policy<Extract<S, Statement>>
  : never;

declare namespace alchemy {
  function bind<S extends readonly Statement<any>[]>(
    ...actions: S
  ): Policy<S[number]>;

  function deploy<E extends Effect.Effect<any, any, any>>(
    effect: E,
    policy: NoInfer<MinimalPolicy<E>>,
  ): Effect.Effect<void, never, never>;
}

export interface Allow<
  Resource extends string,
  Action extends string,
  Condition = any,
> {
  effect: "Allow";
  action: Action;
  resource: Resource;
  condition?: Condition;
}

export interface Deny<
  Resource extends string,
  Action extends string,
  Condition = any,
> {
  effect: "Deny";
  action: Action;
  resource: Resource;
  condition?: Condition;
}

export type Statement<
  Resource extends string = string,
  Action extends string = string,
> = Allow<Resource, Action> | Deny<Resource, Action>;

// A policy is invariant over its allowed actions
export interface Policy<in out Statements extends Statement> {
  readonly statements: Statements;
}

const bucket = Bucket("bucket");

const fetch = Effect.gen(function* () {
  return yield* bucket.get("key");
});

const deployment = alchemy.deploy(
  fetch,
  alchemy.bind(Bucket.Get(bucket, "key")),
);

await Effect.runPromise(deployment);
