import type * as Native from "alchemy/Workers/Workerd/DurableObjectStorage";
import {
  fromDurableObjectStorage as fromNativeStorage,
  fromDurableObjectTransaction as fromNativeTransaction,
} from "alchemy/Workers/Workerd/DurableObjectStorage";

export type SqlStorageValue = Native.SqlStorageValue;

export interface SqlCursor<T extends Record<string, SqlStorageValue>> extends Native.SqlCursor<T> {}

export interface SqlStorage extends Native.SqlStorage {}

export interface DurableObjectTransaction extends Native.DurableObjectTransaction {}

export { DurableObjectStorageError } from "alchemy/Workers/Workerd/DurableObjectStorage";

/** Celld's native KV, SQLite, transactions, and alarms. */
export interface DurableObjectStorage extends Omit<
  Native.DurableObjectStorage,
  "getCurrentBookmark" | "getBookmarkForTime" | "onNextSessionRestoreBookmark"
> {
  sql: SqlStorage;
}

export const fromDurableObjectStorage: (
  storage: Parameters<typeof fromNativeStorage>[0],
) => DurableObjectStorage = fromNativeStorage;

export const fromDurableObjectTransaction: (
  transaction: Parameters<typeof fromNativeTransaction>[0],
) => DurableObjectTransaction = fromNativeTransaction;
