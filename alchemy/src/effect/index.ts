import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

export interface Binding<ID extends string, Action extends string> {
  readonly resource: ID;
  readonly action: Action;
}

// TODO(sam): are there errors?
export type SendMessageError = never;

export type Queue<ID extends string, Msg> = {
  send(
    message: Msg,
  ): Effect.Effect<void, SendMessageError, Queue.Send<ID, Msg>>;
  sendBatch(
    ...message: Msg[]
  ): Effect.Effect<void, SendMessageError, Queue.SendBatch<ID, Msg>>;
};

export declare namespace Queue {
  // export interface Send<ID extends string> extends Binding<ID, "Queue::Send"> {}
  export type Send<ID extends string, Msg> = Allow<
    ID,
    "Queue::Send",
    { message: Msg }
  >;
  export function Send<ID extends string, Msg>(
    queue: Queue<ID, Msg>,
  ): Send<ID, Msg>;
  export type SendBatch<ID extends string, Msg> = Allow<
    ID,
    "Queue::SendBatch",
    { message: Msg[] }
  >;
  export function SendBatch<ID extends string, Msg>(
    queue: Queue<ID, Msg>,
  ): SendBatch<ID, Msg>;
}

export function Queue<ID extends string>(id: ID) {
  return <T>(): Queue<ID, T> => ({
    send: (message: T) => Effect.succeed(void 0),
    sendBatch: (...message: T[]) => Effect.succeed(void 0),
  });
}

export type Bucket<ID extends string> = {
  get<const Key extends string = string>(
    key: Key,
  ): Effect.Effect<string | undefined, never, Bucket.Get<ID, Key>>;
  put(
    key: string,
    value: string,
  ): Effect.Effect<void, never, Bucket.Put<ID, string>>;
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
  ): Get<ID, Key>;
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
  ): Put<ID, Key>;
}

export type KVNamespace<
  ID extends string,
  Key extends string,
  Value extends string,
> = {
  get(
    key: Key,
  ): Effect.Effect<Value | undefined, never, KVNamespace.Get<ID, Key, Value>>;
  put(
    key: Key,
    value: Value,
  ): Effect.Effect<void, never, KVNamespace.Put<ID, Key, Value>>;
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
  >(kv: KVNamespace<ID, Key, Value>): Get<ID, Key, Value>;
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
  >(kv: KVNamespace<ID, Key, Value>): Put<ID, Key, Value>;
  export function put<
    ID extends string,
    Key extends string,
    Value extends string,
  >(kv: KVNamespace<ID, Key, Value>): Layer.Layer<Put<ID, Key, Value>>;
}

type GetStatements<E> = E extends Effect.Effect<any, any, infer S>
  ? Extract<S, Statement>
  : Extract<E, Statement>;

type MinimalPolicy<E> = Policy<GetStatements<E>>;

declare namespace alchemy {
  function bind<S extends readonly Statement<any>[]>(
    ...actions: S
  ): Policy<S[number]>;

  function deploy<W extends Worker<string, any, any>>(
    worker: W,
    policy: NoInfer<MinimalPolicy<Worker.Requirements<W>>>,
  ): Effect.Effect<void, never, never>;

  function client<W extends Worker<string, any, any>>(
    baseUrl: string,
  ): {
    fetch(
      url: string,
      init?: RequestInit,
    ): Effect.Effect<Response, Worker.Error<W>, never>;
    fetch(request: Request): Effect.Effect<Response, Worker.Error<W>, never>;
  };

  function runtime<E extends Effect.Effect<Handler, any, never>>(
    worker: E,
  ): Handler;
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
export interface Policy<in out Statements extends Statement> {
  readonly statements: Statements;
}

export type Handler = {
  fetch: (
    request: Request,
    env: any,
    ctx: ExecutionContext,
  ) => Promise<Response>;
};

export type Worker<ID extends string = string, Err = any, Req = any> = {
  resource: ID;
  fetch: (request: Request) => Effect.Effect<Response, Err, Worker.Fetch<ID>>;
} & Effect.Effect<Handler, never, Req>;

export declare function Worker<ID extends string, Err = never, Req = any>(
  id: ID,
  props: {
    main: string;
    fetch: (request: Request) => Effect.Effect<Response, Err, Req>;
  },
): Worker<ID, Err, Req>;

export declare namespace Worker {
  export type Requirements<W extends Worker> = W extends Effect.Effect<
    any,
    any,
    infer R
  >
    ? R
    : never;

  export type Error<W extends Worker> = W extends Effect.Effect<
    any,
    infer E,
    any
  >
    ? E
    : never;

  export type Fetch<ID extends string> = Allow<ID, "Worker::Fetch">;
  export function Fetch<ID extends string>(worker: Worker<ID>): Fetch<ID>;
}
const kv = KVNamespace("kv")();

// THE HOLY TRINITY 🔱

// 1. business logic & contract
const bucket = Bucket("bucket");

const backend = Worker("backend", {
  main: import.meta.file,
  fetch: (request: Request) =>
    Effect.gen(function* () {
      return new Response(yield* bucket.get(request.url));
    }),
});

// 2. optimally tree-shaken handler
export default Effect.provide(backend, Bucket.get(bucket)).pipe(
  alchemy.runtime,
);

// 3. materialize infrastructure with least-privilege IAM policy
const deployment = alchemy.deploy(backend, alchemy.bind(Bucket.Get(bucket)));

await Effect.runPromise(deployment);

// 4. client in the browser
const client = alchemy.client<typeof backend>("https://api.example.com");

Effect.gen(function* () {
  yield* client.fetch("/api/data", {
    method: "GET",
  });
});

const frontend = Worker("frontend", {
  main: import.meta.file,
  fetch: (request: Request) =>
    Effect.gen(function* () {
      if (request.url.startsWith("/api/")) {
        return yield* Effect.fail(new Error("Not implemented"));
      }
      return yield* backend.fetch(request);
    }),
});

const deployBackend = alchemy.deploy(backend, alchemy.bind(Bucket.Get(bucket)));

const deployFrontend = alchemy.deploy(
  frontend,
  alchemy.bind(Worker.Fetch(backend)),
);

await Effect.runPromise(deployBackend);
await Effect.runPromise(deployFrontend);
