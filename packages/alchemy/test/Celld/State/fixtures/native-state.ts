import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";

const unexpected = (): never => {
  throw new Error("Native state operation is outside this fixture");
};

function get<T>(
  key: string,
  options?: cf.DurableObjectGetOptions,
): Promise<T | undefined>;
function get<T>(
  keys: string[],
  options?: cf.DurableObjectGetOptions,
): Promise<Map<string, T>>;
function get<T>(
  keys: string | string[],
): Promise<T | undefined | Map<string, T>> {
  return Effect.runPromise(
    Effect.sync(() =>
      typeof keys === "string" ? undefined : new Map<string, T>(),
    ),
  );
}

export const nativeState = (
  pending: Promise<unknown>[],
): cf.DurableObjectState => ({
  id: {
    toString: () => "cell",
    equals: (other) => other.toString() === "cell",
  },
  storage: {
    get,
    list: unexpected,
    put: unexpected,
    delete: unexpected,
    deleteAll: unexpected,
    transaction: unexpected,
    transactionSync: unexpected,
    getAlarm: unexpected,
    setAlarm: unexpected,
    deleteAlarm: unexpected,
    sync: unexpected,
    getCurrentBookmark: unexpected,
    getBookmarkForTime: unexpected,
    onNextSessionRestoreBookmark: unexpected,
    sql: {
      exec: unexpected,
      databaseSize: 0,
      get Cursor() {
        return unexpected();
      },
      get Statement() {
        return unexpected();
      },
    },
    kv: {
      get: unexpected,
      put: unexpected,
      list: unexpected,
      delete: unexpected,
    },
  },
  exports: {},
  props: { key: "value" },
  facets: {
    get: unexpected,
    abort: unexpected,
    delete: unexpected,
    clone: unexpected,
  },
  waitUntil: (work) => {
    pending.push(work);
  },
  blockConcurrencyWhile: (callback) => callback(),
  acceptWebSocket: unexpected,
  getWebSockets: () => [],
  getTags: () => ["tag"],
  setWebSocketAutoResponse: unexpected,
  getWebSocketAutoResponse: unexpected,
  getWebSocketAutoResponseTimestamp: unexpected,
  setHibernatableWebSocketEventTimeout: unexpected,
  getHibernatableWebSocketEventTimeout: unexpected,
  abort: unexpected,
});
