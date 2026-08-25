import * as kvs from "@distilled.cloud/aws/cloudfront-keyvaluestore";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { Credentials } from "../Credentials.ts";
import type { Region } from "../Region.ts";
import {
  extractValue,
  getKvsEtag,
  isKvsPreconditionFailed,
  cappedKvsRetrySchedule,
  retryForKvsReadiness,
  withKvsRegionFn,
} from "./common.ts";

// TEMP TRACE — DO NOT COMMIT
const TRACE = (m: string) =>
  Effect.sync(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("node:fs").appendFileSync(
        "/tmp/kvs-trace.log",
        `${new Date().toISOString()} ${m}\n`,
      );
    } catch {}
  });

export interface KvRoutesUpdateProps {
  /** ARN of the CloudFront KeyValueStore. */
  store: string;
  /** Namespace prefix. The full key is `{namespace}:{key}`. */
  namespace: string;
  /** Key within the namespace (typically "routes"). */
  key: string;
  /** The route entry string to add/manage (format: "type,namespace,hostPattern,pathPrefix"). */
  entry: string;
}

export interface KvRoutesUpdate extends Resource<
  "AWS.CloudFront.KvRoutesUpdate",
  KvRoutesUpdateProps,
  {
    /**
     * The ARN of the key value store holding the routes.
     */
    store: string;
    /**
     * The namespace prefix the routes were written under.
     */
    namespace: string;
    /**
     * The key the route table was written to.
     */
    key: string;
    /**
     * The serialized route table value that was written.
     */
    entry: string;
  },
  never,
  Providers
> {}

/**
 * Manages a single route entry in a JSON array stored in a CloudFront KeyValueStore.
 *
 * The routes array is stored at key `{namespace}:{key}` and supports automatic
 * chunking when the serialized array exceeds 1000 characters.
 * ### Managing Routes
 * **Example:** Add A Route Entry
 * ```typescript
 * const update = yield* KvRoutesUpdate("MyRoute", {
 *   store: store.keyValueStoreArn,
 *   namespace: "app",
 *   key: "routes",
 *   entry: "site,mysite,*,/",
 * });
 * ```
 *
 * @resource
 */
export const KvRoutesUpdate = Resource<KvRoutesUpdate>(
  "AWS.CloudFront.KvRoutesUpdate",
);

const CHUNK_SIZE = 1000;

export const KvRoutesUpdateProvider = () =>
  Provider.effect(
    KvRoutesUpdate,
    Effect.gen(function* () {
      const getRoutes = Effect.fn(function* (store: string, fullKey: string) {
        const res = yield* kvs
          .getKey({ KvsARN: store, Key: fullKey })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

        if (!res) {
          return { routes: [] as string[], chunkNum: 1 };
        }

        const raw = extractValue(res.Value);
        const parsed = JSON.parse(raw);

        if (parsed && typeof parsed === "object" && "parts" in parsed) {
          const parts: number = parsed.parts;
          const chunks: string[] = [];
          for (let i = 0; i < parts; i++) {
            const chunkRes = yield* kvs.getKey({
              KvsARN: store,
              Key: `${fullKey}:${i}`,
            });
            chunks.push(extractValue(chunkRes.Value));
          }
          return {
            routes: JSON.parse(chunks.join("")) as string[],
            chunkNum: parts,
          };
        }

        return { routes: parsed as string[], chunkNum: 1 };
      });

      const setRoutes = Effect.fn(function* (
        store: string,
        etag: string,
        fullKey: string,
        routes: string[],
        oldChunkNum: number,
      ) {
        const serialized = JSON.stringify(routes);
        const puts: kvs.PutKeyRequestListItem[] = [];
        const deletes: kvs.DeleteKeyRequestListItem[] = [];

        if (serialized.length > CHUNK_SIZE) {
          const chunkCount = Math.ceil(serialized.length / CHUNK_SIZE);
          puts.push({
            Key: fullKey,
            Value: JSON.stringify({ parts: chunkCount }),
          });
          for (let i = 0; i < chunkCount; i++) {
            puts.push({
              Key: `${fullKey}:${i}`,
              Value: serialized.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
            });
          }
          if (oldChunkNum > chunkCount) {
            for (let i = chunkCount; i < oldChunkNum; i++) {
              deletes.push({ Key: `${fullKey}:${i}` });
            }
          }
        } else {
          puts.push({ Key: fullKey, Value: serialized });
          if (oldChunkNum > 1) {
            for (let i = 0; i < oldChunkNum; i++) {
              deletes.push({ Key: `${fullKey}:${i}` });
            }
          }
        }

        yield* TRACE(
          `RU setRoutes store=…${store.slice(-12)} etag=${etag} puts=${JSON.stringify(puts.map((x) => x.Key))} deletes=${JSON.stringify(deletes.map((x) => x.Key))}`,
        );
        yield* kvs
          .updateKeys({
            KvsARN: store,
            IfMatch: etag,
            Puts: puts.length > 0 ? puts : undefined,
            Deletes: deletes.length > 0 ? deletes : undefined,
          })
          .pipe(
            Effect.tap((r) =>
              TRACE(`RU setRoutes OK newEtag=${(r as any)?.ETag}`),
            ),
            Effect.tapError((e) =>
              TRACE(
                `RU setRoutes ERR ${(e as any)._tag}: ${String((e as any).message).slice(0, 120)}`,
              ),
            ),
          );
      });

      const deleteKey = Effect.fn(function* (
        store: string,
        etag: string,
        fullKey: string,
        oldChunkNum: number,
      ) {
        const deletes: kvs.DeleteKeyRequestListItem[] = [{ Key: fullKey }];
        if (oldChunkNum > 1) {
          for (let i = 0; i < oldChunkNum; i++) {
            deletes.push({ Key: `${fullKey}:${i}` });
          }
        }
        yield* TRACE(
          `RU deleteKey store=…${store.slice(-12)} etag=${etag} deletes=${JSON.stringify(deletes.map((x) => x.Key))}`,
        );
        yield* kvs
          .updateKeys({
            KvsARN: store,
            IfMatch: etag,
            Deletes: deletes,
          })
          .pipe(
            Effect.tap(() => TRACE("RU deleteKey OK")),
            Effect.tapError((e) =>
              TRACE(`RU deleteKey ERR ${(e as any)._tag}`),
            ),
          );
      });

      const deleteOp = (
        props: KvRoutesUpdateProps,
      ): Effect.Effect<
        void,
        kvs.UpdateKeysError,
        Credentials | Region | HttpClient
      > =>
        Effect.gen(function* () {
          const fullKey = `${props.namespace}:${props.key}`;
          const etag = yield* getKvsEtag(props.store);
          const { routes, chunkNum } = yield* getRoutes(props.store, fullKey);
          const filtered = routes.filter((r) => r !== props.entry);
          if (filtered.length === 0) {
            yield* deleteKey(props.store, etag, fullKey, chunkNum);
          } else {
            yield* setRoutes(props.store, etag, fullKey, filtered, chunkNum);
          }
        }).pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "ValidationException" &&
              isKvsPreconditionFailed(error),
            schedule: cappedKvsRetrySchedule,
          }),
        );

      const upsertEntry = (
        store: string,
        fullKey: string,
        entryToAdd: string,
        entryToRemove: string | undefined,
      ): Effect.Effect<
        void,
        kvs.UpdateKeysError,
        HttpClient | Region | Credentials
      > =>
        Effect.gen(function* () {
          const etag = yield* getKvsEtag(store);
          const { routes, chunkNum } = yield* getRoutes(store, fullKey);
          yield* TRACE(
            `RU upsertEntry store=…${store.slice(-12)} key=${fullKey} etag=${etag} existingRoutes=${JSON.stringify(routes)} add=${entryToAdd} remove=${entryToRemove ?? "-"}`,
          );
          const filtered =
            entryToRemove !== undefined
              ? routes.filter((r) => r !== entryToRemove)
              : routes.slice();
          if (!filtered.includes(entryToAdd)) {
            filtered.push(entryToAdd);
          }
          yield* setRoutes(store, etag, fullKey, filtered, chunkNum);
        }).pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "ValidationException" &&
              isKvsPreconditionFailed(error),
            schedule: cappedKvsRetrySchedule,
          }),
        );

      return {
        // Non-listable: this resource is an update operation that manages a
        // single route entry inside a JSON array stored at a KV store key. It is
        // keyed entirely by {store, namespace, key, entry}; there is no API that
        // enumerates individual route-entry updates, so list returns [].
        list: () => Effect.succeed([]),
        read: withKvsRegionFn(
          Effect.fn(function* ({ output }) {
            return output;
          }),
        ),
        reconcile: withKvsRegionFn(
          Effect.fn(function* ({ news, output }) {
            yield* TRACE(
              `RU reconcile ENTER store=…${String(news.store).slice(-12)} ns=${news.namespace} key=${news.key} entry=${news.entry} hasOutput=${output !== undefined}`,
            );
            return yield* retryForKvsReadiness(
              Effect.gen(function* () {
                // Observe — figure out whether the prior entry lived at a
                // different location. When location changes (or this is
                // the first reconcile), we strip the old entry from the
                // old routes array first, then add the new one to the
                // new array.
                const movedLocation =
                  output !== undefined &&
                  (output.store !== news.store ||
                    output.namespace !== news.namespace ||
                    output.key !== news.key);

                if (movedLocation) {
                  yield* deleteOp(output);
                }

                // Sync — append the desired entry to the routes array at
                // the new location. If the entry was previously at the
                // same location, drop the old value from the in-memory
                // array before re-appending so a value change is treated
                // as upsert-by-replace.
                const fullKey = `${news.namespace}:${news.key}`;
                const previousEntry =
                  !movedLocation && output !== undefined
                    ? output.entry
                    : undefined;
                yield* upsertEntry(
                  news.store,
                  fullKey,
                  news.entry,
                  previousEntry,
                );

                yield* TRACE("RU reconcile EXIT ok");
                return {
                  store: news.store,
                  namespace: news.namespace,
                  key: news.key,
                  entry: news.entry,
                };
              }),
            );
          }),
        ),
        delete: withKvsRegionFn(
          Effect.fn(function* ({ output }) {
            yield* TRACE(
              `RU DELETE-OP ENTER store=…${String(output.store).slice(-12)} ns=${output.namespace} entry=${output.entry}`,
            );
            yield* retryForKvsReadiness(
              deleteOp({
                store: output.store,
                namespace: output.namespace,
                key: output.key,
                entry: output.entry,
              }),
            ).pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
          }),
        ),
      };
    }),
  );
