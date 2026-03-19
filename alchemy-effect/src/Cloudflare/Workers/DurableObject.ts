import type * as cf from "@cloudflare/workers-types";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ServiceMap from "effect/ServiceMap";
import type { HttpServerError } from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type * as Socket from "effect/unstable/socket/Socket";
import * as Binding from "../../Binding.ts";
import type { HttpEffect } from "../../Http.ts";
import * as Output from "../../Output.ts";
import { Self } from "../../Self.ts";
import { Account } from "../Account.ts";
import cloudflare_workers from "./cloudflare:workers.ts";
import { serveWebRequest } from "./HttpServer.ts";
import type { DurableWebSocket } from "./WebSocket.ts";
import { isWorker, Worker, WorkerEnvironment } from "./Worker.ts";

export type DurableObjectId = cf.DurableObjectId;
export type DurableObjectJurisdiction = cf.DurableObjectJurisdiction;
export type DurableObjectNamespaceGetDurableObjectOptions =
  cf.DurableObjectNamespaceGetDurableObjectOptions;
const DurableObjectNamespaceType = "Cloudflare.Workers.DurableObjectNamespace";

export interface DurableObjectNamespace<
  Name extends string = string,
  Shape = any,
> {
  Type: "Cloudflare.Workers.DurableObjectNamespace";
  name: Name;
  namespaceId: Output.Output<string>;
  getByName: (name: string) => Effect.Effect<DurableObjectStub<Shape>>;
  newUniqueId: () => Effect.Effect<DurableObjectId>;
  idFromName: (name: string) => Effect.Effect<DurableObjectId>;
  idFromString: (id: string) => Effect.Effect<DurableObjectId>;
  get: (
    id: DurableObjectId,
    options?: DurableObjectNamespaceGetDurableObjectOptions,
  ) => Effect.Effect<DurableObjectStub<Shape>>;
  jurisdiction: (
    jurisdiction: DurableObjectJurisdiction,
  ) => Effect.Effect<DurableObjectNamespace<Name, Shape>>;
}

export interface DurableObjectShape {
  fetch: HttpEffect;
  webSocketMessage?: (
    socket: DurableWebSocket,
    message: string | Uint8Array,
  ) => Effect.Effect<void, Socket.SocketError>;
  webSocketClose?: (
    socket: DurableWebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) => Effect.Effect<void, Socket.SocketError>;
}

export const DurableObjectNamespace: {
  <
    Name extends string,
    Shape extends DurableObjectShape,
    NamespaceReq = never,
    InstanceReq = never,
  >(
    name: Name,
    eff: Effect.Effect<
      Effect.Effect<Shape, never, InstanceReq>,
      never,
      NamespaceReq
    >,
  ): Effect.Effect<
    DurableObjectNamespace<
      Name,
      {
        [k in keyof Omit<
          Shape,
          "fetch" | "webSocketMessage" | "webSocketClose"
        >]: Omit<Shape, "fetch" | "webSocketMessage" | "webSocketClose">[k];
      }
    >,
    never,
    | Exclude<
        NamespaceReq | InstanceReq,
        DurableObjectState | Self<DurableObjectNamespace>
      >
    | DurableObjectPolicy
  >;
  Self: Self<DurableObjectNamespace>;
} = Object.assign(
  Effect.fnUntraced(function* (
    name,
    eff: Effect.Effect<Effect.Effect<DurableObjectShape>>,
  ) {
    const worker = yield* Worker.Self;
    const runtime = yield* Worker.Context;

    yield* DurableObjectPolicy.bind(name);

    const DurableObject = yield* cloudflare_workers.pipe(
      Effect.map((m) => m.DurableObject),
    );

    const services = yield* Effect.services<Effect.Services<typeof eff>>();

    yield* runtime.export(
      name,
      class extends DurableObject {
        constructor(state: cf.DurableObjectState, env: any) {
          super(state, env);

          const runtimeState = fromDurableObjectState(state);

          state.blockConcurrencyWhile(async () => {
            const methods = await Effect.runPromise(
              constructor.pipe(
                Effect.provideServices(services),
                Effect.provideService(DurableObjectState, runtimeState),
                Effect.provideService(WorkerEnvironment, env),
              ),
            );

            Object.assign(this, wrapDurableObjectShape(methods, state));
          });
        }
      },
    );

    const binding = Effect.serviceOption(WorkerEnvironment).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.flatMap((env) => {
        if (env === undefined) {
          // should be fine to return undefined here (it is only undefined at plantime)
          return undefined!;
        }
        const ns = env[name];
        if (!ns) {
          return Effect.die(
            new Error(`DurableObjectNamespace '${name}' not found`),
          );
        } else if (typeof ns.getByName === "function") {
          return Effect.succeed(ns);
        } else {
          return Effect.die(
            new Error(
              `DurableObjectNamespace '${name}' is not a DurableObjectNamespace`,
            ),
          );
        }
      }),
    );

    const use = <T>(fn: (ns: cf.DurableObjectNamespace) => T) =>
      binding.pipe(Effect.map((ns) => fn(ns)));

    const namespaceId = worker.workerName.pipe(
      // TODO(sam): move out to a plantime function
      Output.mapEffect((scriptName) =>
        Account.asEffect().pipe(
          Effect.flatMap((accountId) =>
            workers.getScriptScriptAndVersionSetting({
              accountId: accountId.toString(),
              scriptName,
            }),
          ),
          Effect.flatMap((setting) => {
            const namespaceId = setting.bindings?.find(
              (
                binding,
              ): binding is typeof binding & {
                type: "dispatch_namespace";
                namespaceId: string;
              } =>
                binding.type === "durable_object_namespace" &&
                binding.className === name,
            )?.namespaceId;
            return namespaceId
              ? Effect.succeed(namespaceId)
              : Effect.die(
                  new Error(`DurableObjectNamespace '${name}' not found`),
                );
          }),
          Effect.orDie,
        ),
      ),
    );

    const self: DurableObjectNamespace<any, any> = {
      Type: DurableObjectNamespaceType,
      name: name,
      namespaceId,
      getByName: (name: string) =>
        use((ns) => wrapDurableObjectStub(ns.getByName(name))),
      newUniqueId: () => use((ns) => ns.newUniqueId()),
      idFromName: (name: string) => use((ns) => ns.idFromName(name)),
      idFromString: (id: string) => use((ns) => ns.idFromString(id)),
      get: (
        id: cf.DurableObjectId,
        options?: cf.DurableObjectNamespaceGetDurableObjectOptions,
      ) => use((ns) => wrapDurableObjectStub(ns.get(id, options))),
      jurisdiction: (jurisdiction: cf.DurableObjectJurisdiction) =>
        use((ns) => ns.jurisdiction(jurisdiction)),
    };

    const constructor = yield* eff.pipe(
      Effect.provideService(DurableObjectNamespace.Self, self),
    );

    return self;
  }),
  {
    Self: Self<DurableObjectNamespace<any, any>>(DurableObjectNamespaceType),
  },
) as any;

export class DurableObjectPolicy extends Binding.Policy<
  DurableObjectPolicy,
  (namespace: string) => Effect.Effect<void>
>()("Cloudflare.Workers.DurableObject") {}

export const DurableObjectPolicyLive = DurableObjectPolicy.layer.succeed(
  Effect.fn(function* (host, namespace: string) {
    if (isWorker(host)) {
      yield* host.bind`Bind(DurableObject(${namespace}))`({
        // TODO(sam): automate class migrations, probably in the provider
        bindings: [
          {
            type: "durable_object_namespace",
            name: namespace,
            class_name: namespace,
            // script_name:
            //   binding.scriptName === props.workerName
            //     ? undefined
            //     : binding.scriptName,
            // environment: binding.environment,
            // namespace_id: binding.namespaceId,
          },
        ],
      });
    } else {
      return yield* Effect.die(
        `DurableObjectPolicy does not support runtime '${host.Type}'`,
      );
    }
  }),
);

export type DurableObjectStub<Shape> = {
  // TODO(sam): do we need to transform? hopefully not
  [key in keyof Shape]: Shape[key];
} & {
  fetch: (
    request: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError,
    never
  >;
};

export class DurableObjectState extends ServiceMap.Service<
  DurableObjectState,
  {
    // TODO(sam): is this needed when we have Effect?
    // waitUntil(promise: Promise<any>): Effect.Effect<void>;

    // TODO(sam): what are these? Where do they come from?
    // readonly props: Props;

    readonly id: cf.DurableObjectId;
    readonly storage: DurableObjectStorage;
    // TODO(sam): effect-native interface for container
    container?: cf.Container;
    blockConcurrencyWhile<T>(
      callback: () => Effect.Effect<T>,
    ): Effect.Effect<T>;
    // acceptWebSocket(ws: cf.WebSocket, tags?: string[]): Effect.Effect<void>;
    getWebSockets(tag?: string): Effect.Effect<DurableWebSocket[]>;
    setWebSocketAutoResponse(
      maybeReqResp?: cf.WebSocketRequestResponsePair,
    ): Effect.Effect<void>;
    getWebSocketAutoResponse(): Effect.Effect<cf.WebSocketRequestResponsePair | null>;
    getWebSocketAutoResponseTimestamp(
      ws: cf.WebSocket,
    ): Effect.Effect<Date | null>;
    setHibernatableWebSocketEventTimeout(
      timeoutMs?: number,
    ): Effect.Effect<void>;
    getHibernatableWebSocketEventTimeout(): Effect.Effect<number | null>;
    getTags(ws: cf.WebSocket): Effect.Effect<string[]>;
    abort(reason?: string): Effect.Effect<void>;
  }
>()("Cloudflare.Workers.DurableObjectState") {}

export interface DurableObjectTransaction {
  get<T = unknown>(
    key: string,
    options?: cf.DurableObjectGetOptions,
  ): Effect.Effect<T | undefined>;
  get<T = unknown>(
    keys: string[],
    options?: cf.DurableObjectGetOptions,
  ): Effect.Effect<Map<string, T>>;
  list<T = unknown>(
    options?: cf.DurableObjectListOptions,
  ): Effect.Effect<Map<string, T>>;
  put<T>(
    key: string,
    value: T,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<void>;
  put<T>(
    entries: Record<string, T>,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<void>;
  delete(
    key: string,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<boolean>;
  delete(
    keys: string[],
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<number>;
  rollback(): Effect.Effect<void>;
  getAlarm(
    options?: cf.DurableObjectGetAlarmOptions,
  ): Effect.Effect<number | null>;
  setAlarm(
    scheduledTime: number | Date,
    options?: cf.DurableObjectSetAlarmOptions,
  ): Effect.Effect<void>;
  deleteAlarm(options?: cf.DurableObjectSetAlarmOptions): Effect.Effect<void>;
}
export interface DurableObjectStorage {
  get<T = unknown>(
    key: string,
    options?: cf.DurableObjectGetOptions,
  ): Effect.Effect<T | undefined>;
  get<T = unknown>(
    keys: string[],
    options?: cf.DurableObjectGetOptions,
  ): Effect.Effect<Map<string, T>>;
  list<T = unknown>(
    options?: cf.DurableObjectListOptions,
  ): Effect.Effect<Map<string, T>>;
  put<T>(
    key: string,
    value: T,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<void>;
  put<T>(
    entries: Record<string, T>,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<void>;
  delete(
    key: string,
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<boolean>;
  delete(
    keys: string[],
    options?: cf.DurableObjectPutOptions,
  ): Effect.Effect<number>;
  deleteAll(options?: cf.DurableObjectPutOptions): Effect.Effect<void>;
  transaction<T>(
    closure: (txn: DurableObjectTransaction) => Effect.Effect<T>,
  ): Effect.Effect<T>;
  getAlarm(
    options?: cf.DurableObjectGetAlarmOptions,
  ): Effect.Effect<number | null>;
  setAlarm(
    scheduledTime: number | Date,
    options?: cf.DurableObjectSetAlarmOptions,
  ): Effect.Effect<void>;
  deleteAlarm(options?: cf.DurableObjectSetAlarmOptions): Effect.Effect<void>;
  sync(): Effect.Effect<void>;
  sql: cf.SqlStorage;
  kv: cf.SyncKvStorage;
  transactionSync<T>(closure: () => T): T;
  getCurrentBookmark(): Effect.Effect<string>;
  getBookmarkForTime(timestamp: number | Date): Effect.Effect<string>;
  onNextSessionRestoreBookmark(bookmark: string): Effect.Effect<string>;
}

const wrapDurableObjectShape = (
  shape: DurableObjectShape,
  state: cf.DurableObjectState,
) =>
  Object.fromEntries(
    Object.entries(shape).map(([key, value]) => [
      key,
      key === "fetch"
        ? wrapFetch(value as HttpEffect, state)
        : wrapMethod(value as DurableObjectShape[keyof DurableObjectShape]),
    ]),
  );

const wrapFetch =
  (handler: HttpEffect, state: cf.DurableObjectState) =>
  (request: cf.Request): Promise<Response> =>
    Effect.runPromise(
      serveWebRequest(request, handler, {
        remoteAddress: request.headers.get("cf-connecting-ip") ?? undefined,
        acceptWebSocket: (socket) => state.acceptWebSocket(socket),
      }),
    );

const wrapMethod = (value: DurableObjectShape[keyof DurableObjectShape]) => {
  if (Effect.isEffect(value)) {
    return () => Effect.runPromise(value as Effect.Effect<any>);
  }
  if (typeof value === "function") {
    return (...args: ReadonlyArray<any>) => {
      const result = value(...args);
      return Effect.isEffect(result) ? Effect.runPromise(result) : result;
    };
  }
  return value;
};

const wrapDurableObjectStub = <Shape>(stub: cf.DurableObjectStub): Shape =>
  new Proxy(stub as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      if (property === "fetch") {
        return (request: HttpServerRequest.HttpServerRequest) =>
          HttpServerRequest.toWeb(request).pipe(
            Effect.flatMap((webRequest) =>
              Effect.tryPromise(() =>
                (value as (request: Request) => Promise<Response>).call(
                  target,
                  webRequest,
                ),
              ),
            ),
            Effect.map(HttpServerResponse.fromWeb),
          );
      }
      return (...args: ReadonlyArray<any>) =>
        Effect.tryPromise(() => Promise.resolve(value.apply(target, args)));
    },
  }) as Shape;

const fromDurableObjectState = (
  state: cf.DurableObjectState,
): DurableObjectState["Service"] => ({
  id: state.id,
  storage: fromDurableObjectStorage(state.storage),
  blockConcurrencyWhile: <T>(callback: () => Effect.Effect<T>) =>
    Effect.tryPromise(() =>
      state.blockConcurrencyWhile(() => Effect.runPromise(callback())),
    ),
  acceptWebSocket: (ws: cf.WebSocket, tags?: string[]) =>
    Effect.sync(() => state.acceptWebSocket(ws, tags)),
  getWebSockets: (tag?: string) => Effect.sync(() => state.getWebSockets(tag)),
  setWebSocketAutoResponse: (maybeReqResp?: cf.WebSocketRequestResponsePair) =>
    Effect.sync(() => state.setWebSocketAutoResponse(maybeReqResp)),
  getWebSocketAutoResponse: () =>
    Effect.sync(() => state.getWebSocketAutoResponse()),
  getWebSocketAutoResponseTimestamp: (ws: cf.WebSocket) =>
    Effect.sync(() => state.getWebSocketAutoResponseTimestamp(ws)),
  setHibernatableWebSocketEventTimeout: (timeoutMs?: number) =>
    Effect.sync(() => state.setHibernatableWebSocketEventTimeout(timeoutMs)),
  getHibernatableWebSocketEventTimeout: () =>
    Effect.sync(() => state.getHibernatableWebSocketEventTimeout()),
  getTags: (ws: cf.WebSocket) => Effect.sync(() => state.getTags(ws)),
  abort: (reason?: string) => Effect.sync(() => state.abort(reason)),
});

const fromDurableObjectTransaction = (
  txn: cf.DurableObjectTransaction,
): DurableObjectTransaction => ({
  get: ((keyOrKeys: string | string[], options?: cf.DurableObjectGetOptions) =>
    Effect.tryPromise(() => txn.get(keyOrKeys as any, options))) as any,
  list: (options?: cf.DurableObjectListOptions) =>
    Effect.tryPromise(() => txn.list(options)),
  put: ((
    keyOrEntries: string | Record<string, unknown>,
    valueOrOptions?: unknown,
    maybeOptions?: cf.DurableObjectPutOptions,
  ) =>
    typeof keyOrEntries === "string"
      ? Effect.tryPromise(() =>
          txn.put(keyOrEntries, valueOrOptions, maybeOptions),
        )
      : Effect.tryPromise(() =>
          txn.put(
            keyOrEntries,
            valueOrOptions as cf.DurableObjectPutOptions | undefined,
          ),
        )) as any,
  delete: ((
    keyOrKeys: string | string[],
    options?: cf.DurableObjectPutOptions,
  ) => Effect.tryPromise(() => txn.delete(keyOrKeys as any, options))) as any,
  rollback: () => Effect.sync(() => txn.rollback()),
  getAlarm: (options?: cf.DurableObjectGetAlarmOptions) =>
    Effect.tryPromise(() => txn.getAlarm(options)),
  setAlarm: (
    scheduledTime: number | Date,
    options?: cf.DurableObjectSetAlarmOptions,
  ) => Effect.tryPromise(() => txn.setAlarm(scheduledTime, options)),
  deleteAlarm: (options?: cf.DurableObjectSetAlarmOptions) =>
    Effect.tryPromise(() => txn.deleteAlarm(options)),
});

const fromDurableObjectStorage = (
  storage: cf.DurableObjectStorage,
): DurableObjectStorage => ({
  get: ((keyOrKeys: string | string[], options?: cf.DurableObjectGetOptions) =>
    Effect.tryPromise(() => storage.get(keyOrKeys as any, options))) as any,
  list: (options?: cf.DurableObjectListOptions) =>
    Effect.tryPromise(() => storage.list(options)),
  put: ((
    keyOrEntries: string | Record<string, unknown>,
    valueOrOptions?: unknown,
    maybeOptions?: cf.DurableObjectPutOptions,
  ) =>
    typeof keyOrEntries === "string"
      ? Effect.tryPromise(() =>
          storage.put(keyOrEntries, valueOrOptions, maybeOptions),
        )
      : Effect.tryPromise(() =>
          storage.put(
            keyOrEntries,
            valueOrOptions as cf.DurableObjectPutOptions | undefined,
          ),
        )) as any,
  delete: ((
    keyOrKeys: string | string[],
    options?: cf.DurableObjectPutOptions,
  ) =>
    Effect.tryPromise(() => storage.delete(keyOrKeys as any, options))) as any,
  deleteAll: (options?: cf.DurableObjectPutOptions) =>
    Effect.tryPromise(() => storage.deleteAll(options)),
  transaction: <T>(
    closure: (txn: DurableObjectTransaction) => Effect.Effect<T>,
  ) =>
    Effect.tryPromise(() =>
      storage.transaction((txn) =>
        Effect.runPromise(closure(fromDurableObjectTransaction(txn))),
      ),
    ),
  getAlarm: (options?: cf.DurableObjectGetAlarmOptions) =>
    Effect.tryPromise(() => storage.getAlarm(options)),
  setAlarm: (
    scheduledTime: number | Date,
    options?: cf.DurableObjectSetAlarmOptions,
  ) => Effect.tryPromise(() => storage.setAlarm(scheduledTime, options)),
  deleteAlarm: (options?: cf.DurableObjectSetAlarmOptions) =>
    Effect.tryPromise(() => storage.deleteAlarm(options)),
  sync: () => Effect.tryPromise(() => storage.sync()),
  sql: storage.sql,
  kv: storage.kv,
  transactionSync: <T>(closure: () => T) => storage.transactionSync(closure),
  getCurrentBookmark: () =>
    Effect.tryPromise(() => storage.getCurrentBookmark()),
  getBookmarkForTime: (timestamp: number | Date) =>
    Effect.tryPromise(() => storage.getBookmarkForTime(timestamp)),
  onNextSessionRestoreBookmark: (bookmark: string) =>
    Effect.tryPromise(() => storage.onNextSessionRestoreBookmark(bookmark)),
});
