import type * as Native from "../../Workers/Workerd/DurableObjectStorage.ts";
import {
  fromDurableObjectStorage as fromNativeStorage,
  fromDurableObjectTransaction as fromNativeTransaction,
} from "../../Workers/Workerd/DurableObjectStorage.ts";

export type SqlStorageValue = Native.SqlStorageValue;

export interface SqlCursor<
  T extends Record<string, SqlStorageValue>,
> extends Native.SqlCursor<T> {}

export interface SqlStorage extends Native.SqlStorage {}

export interface DurableObjectTransaction
  extends Native.DurableObjectTransaction {}

export interface DurableObjectStorage extends Native.DurableObjectStorage {
  sql: SqlStorage;
}

export const fromDurableObjectStorage: (
  storage: Parameters<typeof fromNativeStorage>[0],
) => DurableObjectStorage = fromNativeStorage;

export const fromDurableObjectTransaction: (
  transaction: Parameters<typeof fromNativeTransaction>[0],
) => DurableObjectTransaction = fromNativeTransaction;
