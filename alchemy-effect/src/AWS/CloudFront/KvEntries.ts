import * as kvs from "@distilled.cloud/aws/cloudfront-keyvaluestore";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Resource } from "../../Resource.ts";

export interface KvEntriesProps {
  /** ARN of the CloudFront KeyValueStore. */
  store: string;
  /** Namespace prefix for all keys. Keys are stored as `{namespace}:{key}`. */
  namespace: string;
  /** Map of key → value entries to manage. */
  entries: Record<string, string>;
  /** Whether to delete keys under this namespace that are not in `entries`. @default false */
  purge?: boolean;
}

export interface KvEntries
  extends Resource<
    "AWS.CloudFront.KvEntries",
    KvEntriesProps,
    {
      /** ARN of the CloudFront KeyValueStore. */
      store: string;
      /** Namespace prefix used for keys. */
      namespace: string;
      /** Current entries managed under the namespace. */
      entries: Record<string, string>;
    }
  > {}

/**
 * Manages namespaced key-value entries in a CloudFront KeyValueStore.
 *
 * Entries are stored with a `{namespace}:{key}` prefix to allow multiple
 * logical groups within a single store. Updates use batched optimistic
 * concurrency with automatic ETag retry.
 *
 * @section Managing Entries
 * @example Basic Entries
 * ```typescript
 * const entries = yield* KvEntries("Routes", {
 *   store: store.keyValueStoreArn,
 *   namespace: "routes",
 *   entries: {
 *     "/": "/index.html",
 *     "/about": "/about.html",
 *   },
 * });
 * ```
 *
 * @example Purge Stale Keys
 * ```typescript
 * const entries = yield* KvEntries("Routes", {
 *   store: store.keyValueStoreArn,
 *   namespace: "routes",
 *   entries: { "/": "/index.html" },
 *   purge: true,
 * });
 * ```
 */
export const KvEntries = Resource<KvEntries>("AWS.CloudFront.KvEntries");

const BATCH_SIZE = 50;

export const KvEntriesProvider = () =>
  KvEntries.provider.effect(
    Effect.gen(function* () {
      const getEtag = Effect.fn(function* (store: string) {
        const resp = yield* kvs.describeKeyValueStore({ KvsARN: store });
        return resp.ETag;
      });

      const collectAllKeys = Effect.fn(function* (store: string) {
        const keys: { Key: string; Value: string }[] = [];
        let nextToken: string | undefined;
        do {
          const resp = yield* kvs.listKeys({
            KvsARN: store,
            NextToken: nextToken,
          });
          for (const item of resp.Items ?? []) {
            const v = item.Value;
            keys.push({
              Key: item.Key,
              Value: typeof v === "string" ? v : Redacted.value(v),
            });
          }
          nextToken = resp.NextToken;
        } while (nextToken);
        return keys;
      });

      const isPreconditionFailed = (err: kvs.ValidationException) =>
        "Message" in err &&
        typeof err.Message === "string" &&
        err.Message.includes("Pre-Condition failed");

      const sendBatch = Effect.fn(function* (
        store: string,
        etag: string,
        puts: kvs.PutKeyRequestListItem[],
        deletes: kvs.DeleteKeyRequestListItem[],
      ) {
        return yield* kvs.updateKeys({
          KvsARN: store,
          IfMatch: etag,
          Puts: puts.length > 0 ? puts : undefined,
          Deletes: deletes.length > 0 ? deletes : undefined,
        });
      });

      const batchUpdateKeys = Effect.fn(function* (
        store: string,
        etag: string | undefined,
        puts: kvs.PutKeyRequestListItem[],
        deletes: kvs.DeleteKeyRequestListItem[],
      ) {
        let remainingPuts = puts;
        let remainingDeletes = deletes;
        let currentEtag = etag ?? (yield* getEtag(store));

        while (remainingPuts.length > 0 || remainingDeletes.length > 0) {
          const batchPuts = remainingPuts.slice(0, BATCH_SIZE);
          const batchDeletes = remainingDeletes.slice(
            0,
            BATCH_SIZE - batchPuts.length,
          );

          const resp = yield* sendBatch(
            store,
            currentEtag,
            batchPuts,
            batchDeletes,
          ).pipe(
            Effect.catchTag("ValidationException", (err) =>
              isPreconditionFailed(err)
                ? Effect.sleep(
                    `${Math.floor(Math.random() * 400) + 100} millis`,
                  ).pipe(
                    Effect.andThen(getEtag(store)),
                    Effect.andThen((freshEtag) =>
                      sendBatch(store, freshEtag, batchPuts, batchDeletes),
                    ),
                  )
                : Effect.fail(err),
            ),
          );

          currentEtag = resp.ETag;
          remainingPuts = remainingPuts.slice(batchPuts.length);
          remainingDeletes = remainingDeletes.slice(batchDeletes.length);
        }
      });

      const upload = Effect.fn(function* (
        store: string,
        namespace: string,
        entries: Record<string, string>,
        oldEntries: Record<string, string> | undefined,
      ) {
        const puts: kvs.PutKeyRequestListItem[] = [];
        for (const [key, value] of Object.entries(entries)) {
          if (oldEntries === undefined || oldEntries[key] !== value) {
            puts.push({ Key: `${namespace}:${key}`, Value: value });
          }
        }
        if (puts.length > 0) {
          yield* batchUpdateKeys(store, undefined, puts, []);
        }
      });

      const purge = Effect.fn(function* (
        store: string,
        namespace: string,
        keepEntries: Record<string, string> | undefined,
      ) {
        const allKeys = yield* collectAllKeys(store);
        const prefix = `${namespace}:`;
        const deletes: kvs.DeleteKeyRequestListItem[] = [];
        for (const item of allKeys) {
          if (!item.Key.startsWith(prefix)) continue;
          const unprefixed = item.Key.slice(prefix.length);
          if (keepEntries && unprefixed in keepEntries) continue;
          deletes.push({ Key: item.Key });
        }
        if (deletes.length > 0) {
          yield* batchUpdateKeys(store, undefined, [], deletes);
        }
      });

      return {
        read: Effect.fn(function* ({ output }) {
          return output;
        }),
        create: Effect.fn(function* ({ news }) {
          yield* upload(news.store, news.namespace, news.entries, undefined);
          return {
            store: news.store,
            namespace: news.namespace,
            entries: news.entries,
          };
        }),
        update: Effect.fn(function* ({ news, olds, output }) {
          const oldEntries =
            news.store !== olds.store ? undefined : olds.entries;
          yield* upload(news.store, news.namespace, news.entries, oldEntries);
          if (news.purge) {
            yield* purge(news.store, news.namespace, news.entries);
          }
          return {
            store: news.store,
            namespace: news.namespace,
            entries: news.entries,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          if (!output.store) return;
          yield* purge(output.store, output.namespace, undefined);
        }),
      };
    }),
  );
