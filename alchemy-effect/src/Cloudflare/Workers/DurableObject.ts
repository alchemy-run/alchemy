import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";
import * as Binding from "../../Binding.ts";
import type { ToEffect } from "../CloudflareApi.ts";
import { isWorker, Worker, WorkerEnvironment } from "./Worker.ts";

export interface DurableObjectNamespace<Name extends string, Shape> {
  name: Name;
  getByName: (name: string) => Effect.Effect<DurableObjectStub<Shape>>;
  newUniqueId: () => Effect.Effect<cf.DurableObjectId>;
  idFromName: (name: string) => Effect.Effect<cf.DurableObjectId>;
  idFromString: (id: string) => Effect.Effect<cf.DurableObjectId>;
  get: (
    id: cf.DurableObjectId,
    options?: cf.DurableObjectNamespaceGetDurableObjectOptions,
  ) => Effect.Effect<DurableObjectStub<Shape>>;
  jurisdiction: (
    jurisdiction: cf.DurableObjectJurisdiction,
  ) => Effect.Effect<DurableObjectNamespace<Name, Shape>>;
}

export type DurableObjectStub<Shape> = {
  // TODO(sam): do we need to transform? hopefully not
  [key in keyof Shape]: Shape[key];
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
    container?: ToEffect<cf.Container>;
    blockConcurrencyWhile<T>(
      callback: () => Effect.Effect<T>,
    ): Effect.Effect<T>;
    acceptWebSocket(ws: cf.WebSocket, tags?: string[]): Effect.Effect<void>;
    getWebSockets(tag?: string): Effect.Effect<cf.WebSocket[]>;
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

export const DurableObjectNamespace = Effect.fnUntraced(function* <
  const Name extends string,
  Shape extends Record<string, any>,
  Req = never,
>(namespace: Name, eff: Effect.Effect<Shape, never, Req>) {
  const worker = yield* Worker.Runtime;

  const DurableObject = yield* Effect.promise(() =>
    // @ts-expect-error
    import("cloudflare:workers").then((m) => m.DurableObject),
  );

  const services = yield* Effect.services<Req>();

  yield* worker.export(
    namespace,
    class extends DurableObject {
      constructor(state: cf.DurableObjectState, env: any) {
        super(state, env);

        const methods = state.waitUntil(
          Effect.runPromise(eff.pipe(Effect.provide(services))),
        );

        Object.assign(this, methods);
      }
    },
  );

  yield* DurableObjectPolicy.bind(namespace);

  const DurableObjectNamespace = WorkerEnvironment.asEffect().pipe(
    Effect.flatMap((env) => {
      const ns = env[namespace];
      if (!ns) {
        return Effect.die(
          new Error(`DurableObjectNamespace '${namespace}' not found`),
        );
      } else if (typeof ns.getByName === "function") {
        return Effect.succeed(ns);
      } else {
        return Effect.die(
          new Error(
            `DurableObjectNamespace '${namespace}' is not a DurableObjectNamespace`,
          ),
        );
      }
    }),
  );
  const use = <T>(
    fn: (
      ns: cf.DurableObjectNamespace<Shape & cf.Rpc.DurableObjectBranded>,
    ) => T,
  ) => DurableObjectNamespace.pipe(Effect.map((ns) => fn(ns)));

  return {
    // @ts-expect-error - TODO(sam): we need to build a proxy around Cloudflare RPC
    getByName: (name: string) => use((ns) => ns.getByName(name) as Shape),
    newUniqueId: () => use((ns) => ns.newUniqueId()),
    idFromName: (name: string) => use((ns) => ns.idFromName(name)),
    idFromString: (id: string) => use((ns) => ns.idFromString(id)),
    get: (
      id: cf.DurableObjectId,
      options?: cf.DurableObjectNamespaceGetDurableObjectOptions,
    ) => use((ns) => ns.get(id, options)),
    jurisdiction: (jurisdiction: cf.DurableObjectJurisdiction) =>
      use((ns) => ns.jurisdiction(jurisdiction)),
  };
});

export class DurableObjectPolicy extends Binding.Policy<
  DurableObjectPolicy,
  (namespace: string) => Effect.Effect<void>
>()("Cloudflare.Workers.DurableObject") {}

export const DurableObjectPolicyLive = DurableObjectPolicy.layer.succeed(
  Effect.fn(function* (host, namespace: string) {
    if (isWorker(host)) {
      yield* host.bind`Bind(DurableObject(${namespace}))`({
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
        new Error(
          `DurableObjectPolicy does not support runtime '${host.Type}'`,
        ),
      );
    }
  }),
);
