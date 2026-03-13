import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Resource } from "../../Resource.ts";

export interface KeyValueStoreProps {
  /**
   * KeyValueStore name. If omitted, a deterministic name is generated.
   */
  name?: string;
  /**
   * Optional store comment.
   */
  comment?: string;
}

export interface KeyValueStore extends Resource<
  "AWS.CloudFront.KeyValueStore",
  KeyValueStoreProps,
  {
    /**
     * KeyValueStore ID.
     */
    keyValueStoreId: string;
    /**
     * Store ARN.
     */
    keyValueStoreArn: string;
    /**
     * Store name.
     */
    keyValueStoreName: string;
    /**
     * Current comment.
     */
    comment: string;
    /**
     * Current status.
     */
    status: string;
    /**
     * Last modified time.
     */
    lastModifiedTime: Date | undefined;
    /**
     * Latest entity tag for update/delete operations.
     */
    etag: string | undefined;
  }
> {}

/**
 * A CloudFront KeyValueStore for edge metadata.
 *
 * KeyValueStores can be associated with CloudFront Functions and are useful for
 * routing metadata or other small edge-time lookup tables.
 *
 * @section Creating KeyValueStores
 * @example Basic Store
 * ```typescript
 * const store = yield* KeyValueStore("RouterStore", {
 *   comment: "Route metadata",
 * });
 * ```
 */
export const KeyValueStore = Resource<KeyValueStore>(
  "AWS.CloudFront.KeyValueStore",
);

const createName = (id: string, props: KeyValueStoreProps) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({
        id,
        maxLength: 64,
        lowercase: true,
      });

const toAttrs = (
  store: cloudfront.KeyValueStore,
  etag: string | undefined,
  fallbackName: string,
): KeyValueStore["Attributes"] => ({
  keyValueStoreId: store.Id,
  keyValueStoreArn: store.ARN,
  keyValueStoreName: store.Name || fallbackName,
  comment: store.Comment,
  status: store.Status ?? "UNKNOWN",
  lastModifiedTime: store.LastModifiedTime,
  etag,
});

export const KeyValueStoreProvider = () =>
  KeyValueStore.provider.effect(
    Effect.gen(function* () {
      const getByName = Effect.fn(function* (name: string) {
        const listed = yield* cloudfront.listKeyValueStores({});
        const store =
          listed.KeyValueStoreList?.Items?.find((item) => item.Name === name) ?? undefined;
        if (!store?.Name) {
          return undefined;
        }
        return yield* cloudfront
          .describeKeyValueStore({
            Name: store.Name,
          })
          .pipe(
            Effect.catchTag("EntityNotFound", () => Effect.succeed(undefined)),
          );
      });

      return {
        stables: ["keyValueStoreId", "keyValueStoreArn", "keyValueStoreName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if ((yield* createName(id, olds ?? {})) !== (yield* createName(id, news))) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.keyValueStoreName ?? (yield* createName(id, olds ?? {}));
          const current = yield* cloudfront
            .describeKeyValueStore({
              Name: name,
            })
            .pipe(
              Effect.catchTag("EntityNotFound", () => getByName(name)),
            );
          if (!current?.KeyValueStore) {
            return undefined;
          }
          return toAttrs(current.KeyValueStore, current.ETag, name);
        }),
        create: Effect.fn(function* ({ id, news, session }) {
          const name = yield* createName(id, news);
          const created = yield* cloudfront
            .createKeyValueStore({
              Name: name,
              Comment: news.comment,
            })
            .pipe(
              Effect.catchTag("EntityAlreadyExists", () =>
                getByName(name).pipe(
                  Effect.flatMap((existing) =>
                    existing
                      ? Effect.succeed(existing)
                      : Effect.fail(
                          new Error(
                            `CloudFront KeyValueStore '${name}' already exists but could not be recovered`,
                          ),
                        ),
                  ),
                ),
              ),
            );
          if (!created.KeyValueStore) {
            return yield* Effect.fail(
              new Error("createKeyValueStore returned no key value store"),
            );
          }
          yield* session.note(created.KeyValueStore.Id);
          return toAttrs(created.KeyValueStore, created.ETag, name);
        }),
        update: Effect.fn(function* ({ news, output, session }) {
          const updated = yield* cloudfront.updateKeyValueStore({
            Name: output.keyValueStoreName,
            Comment: news.comment ?? "",
            IfMatch: output.etag!,
          });
          if (!updated.KeyValueStore) {
            return yield* Effect.fail(
              new Error("updateKeyValueStore returned no key value store"),
            );
          }
          yield* session.note(output.keyValueStoreId);
          return toAttrs(updated.KeyValueStore, updated.ETag, output.keyValueStoreName);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* cloudfront
            .deleteKeyValueStore({
              Name: output.keyValueStoreName,
              IfMatch: output.etag!,
            })
            .pipe(
              Effect.catchTag("EntityNotFound", () => Effect.void),
            );
        }),
      };
    }),
  );
