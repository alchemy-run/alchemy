import * as dict from "@distilled.cloud/modal/dict";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import { decodeJson, encodeJson, type ModalValueNotJson } from "./BindingHttp.ts";
import { type OpError, operations } from "./internal.ts";

/** The dict operations the clients call, resolved by `ModalBindings.withCredentials`. */
export const DictOps = operations({
  clearDict: dict.clearDict,
  dictContains: dict.dictContains,
  dictContents: dict.dictContents,
  dictLen: dict.dictLen,
  dictPop: dict.dictPop,
  getDict: dict.getDict,
  updateDict: dict.updateDict,
});

export type DictOps = Effect.Success<typeof DictOps>;

/** A dict call's error: the operation's typed errors, and values that aren't JSON. */
export type DictError<K extends keyof DictOps> = OpError<DictOps, K> | ModalValueNotJson;

/**
 * Read access to one dict. Keys and values are JSON: `put("a", { n: 1 })`
 * stores the bytes of `JSON.stringify`, so Python code reads them with
 * `json.loads` (Modal's Python client pickles by default).
 */
export interface ReadDictClient {
  readonly dictId: Effect.Effect<string>;
  /** The value under `key`, or `undefined`. */
  get<A = unknown>(
    key: unknown,
  ): Effect.Effect<A | undefined, DictError<"getDict">, RuntimeContext>;
  /** Whether `key` is present. */
  contains(key: unknown): Effect.Effect<boolean, OpError<DictOps, "dictContains">, RuntimeContext>;
  /** Number of entries. */
  len(): Effect.Effect<number, OpError<DictOps, "dictLen">, RuntimeContext>;
  /** Every entry. */
  entries<A = unknown>(): Effect.Effect<
    ReadonlyArray<readonly [unknown, A]>,
    DictError<"dictContents">,
    RuntimeContext
  >;
}

/** Write access to one dict. */
export interface WriteDictClient {
  readonly dictId: Effect.Effect<string>;
  /** Set `key` to `value`; with `ifNotExists`, only when absent (returns whether it wrote). */
  put(
    key: unknown,
    value: unknown,
    options?: { readonly ifNotExists?: boolean },
  ): Effect.Effect<boolean, OpError<DictOps, "updateDict">, RuntimeContext>;
  /** Set many entries at once. */
  update(
    entries: Iterable<readonly [unknown, unknown]>,
  ): Effect.Effect<void, OpError<DictOps, "updateDict">, RuntimeContext>;
  /** Remove `key` and return its value, or `undefined`. */
  pop<A = unknown>(
    key: unknown,
  ): Effect.Effect<A | undefined, DictError<"dictPop">, RuntimeContext>;
  /** Remove every entry. */
  clear(): Effect.Effect<void, OpError<DictOps, "clearDict">, RuntimeContext>;
}

/** Read and write access to one dict. */
export interface ReadWriteDictClient extends ReadDictClient, WriteDictClient {}

export const makeReadDictClient = (
  dictId: Effect.Effect<string>,
  ops: DictOps,
): ReadDictClient => ({
  dictId,
  get: <A>(key: unknown) =>
    Effect.gen(function* () {
      const encodedKey = yield* encodeJson(key);
      const id = yield* dictId;
      const response = yield* ops.getDict({
        dictId: id,
        key: encodedKey,
      });
      return response.found && response.value !== undefined
        ? yield* decodeJson<A>(response.value)
        : undefined;
    }),
  contains: (key) =>
    Effect.gen(function* () {
      const encodedKey = yield* encodeJson(key);
      const id = yield* dictId;
      const response = yield* ops.dictContains({
        dictId: id,
        key: encodedKey,
      });
      return response.found ?? false;
    }),
  len: () =>
    Effect.gen(function* () {
      const id = yield* dictId;
      const response = yield* ops.dictLen({ dictId: id });
      return response.len ?? 0;
    }),
  entries: <A>() =>
    Effect.gen(function* () {
      const id = yield* dictId;
      const { items } = yield* ops.dictContents({
        dictId: id,
        keys: true,
        values: true,
      });
      return yield* Effect.forEach(items, (entry) =>
        Effect.all([decodeJson(entry.key ?? ""), decodeJson<A>(entry.value ?? "")] as const),
      );
    }),
});

export const makeWriteDictClient = (
  dictId: Effect.Effect<string>,
  ops: DictOps,
): WriteDictClient => ({
  dictId,
  put: (key, value, options = {}) =>
    Effect.gen(function* () {
      const encodedKey = yield* encodeJson(key);
      const id = yield* dictId;
      const response = yield* ops.updateDict({
        dictId: id,
        updates: [{ key: encodedKey, value: yield* encodeJson(value) }],
        ifNotExists: options.ifNotExists,
      });
      return options.ifNotExists ? (response.created ?? false) : true;
    }),
  update: (entries) =>
    Effect.gen(function* () {
      const updates = yield* Effect.forEach([...entries], ([key, value]) =>
        Effect.all({ key: encodeJson(key), value: encodeJson(value) }),
      );
      const id = yield* dictId;
      yield* ops.updateDict({ dictId: id, updates });
    }),
  pop: <A>(key: unknown) =>
    Effect.gen(function* () {
      const encodedKey = yield* encodeJson(key);
      const id = yield* dictId;
      const response = yield* ops.dictPop({
        dictId: id,
        key: encodedKey,
      });
      return response.found && response.value !== undefined
        ? yield* decodeJson<A>(response.value)
        : undefined;
    }),
  clear: () =>
    Effect.gen(function* () {
      const id = yield* dictId;
      yield* ops.clearDict({ dictId: id });
    }),
});

export const makeReadWriteDictClient = (
  dictId: Effect.Effect<string>,
  ops: DictOps,
): ReadWriteDictClient => ({
  ...makeReadDictClient(dictId, ops),
  ...makeWriteDictClient(dictId, ops),
});
