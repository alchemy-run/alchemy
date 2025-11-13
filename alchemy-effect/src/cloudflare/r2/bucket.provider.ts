import type { R2 } from "cloudflare/resources";
import * as Effect from "effect/Effect";
import { App } from "../../app";
import { CloudflareAccountId, CloudflareApi } from "../api";
import { Bucket, type BucketAttr, type BucketProps } from "./bucket";

export const bucketProvider = () =>
  Bucket.provider.effect(
    Effect.gen(function* () {
      const api = yield* CloudflareApi;
      const accountId = yield* CloudflareAccountId;
      const app = yield* App;

      const createName = (id: string, props: BucketProps) =>
        props.name ?? `${app.name}-${id}-${app.stage}`.toLowerCase();

      const mapResult = <Props extends BucketProps>(
        bucket: R2.Bucket,
      ): BucketAttr<Props> =>
        ({
          name: bucket.name,
          storageClass: bucket.storage_class ?? "Standard",
          jurisdiction: bucket.jurisdiction ?? "default",
          location: bucket.location,
          accountId,
        }) as BucketAttr<Props>;

      return {
        diff: ({ id, olds, news, output }) =>
          Effect.sync(() => {
            if (
              output.accountId !== accountId ||
              output.name !== createName(id, news) ||
              output.jurisdiction !== (news.jurisdiction ?? "default") ||
              olds.locationHint !== news.locationHint
            ) {
              return { action: "replace" };
            }
            if (output.storageClass !== (news.storageClass ?? "Standard")) {
              return { action: "update" };
            }
            return { action: "noop" };
          }),
        create: Effect.fnUntraced(function* ({ id, news }) {
          const bucket = yield* api.r2.buckets.create({
            account_id: accountId,
            name: createName(id, news),
            storageClass: news.storageClass,
            jurisdiction: news.jurisdiction,
            locationHint: news.locationHint,
          });
          return mapResult<BucketProps>(bucket);
        }),
        update: Effect.fnUntraced(function* ({ id, news, output }) {
          const bucket = yield* api.r2.buckets.edit(output.name, {
            account_id: output.accountId,
            storage_class: news.storageClass ?? output.storageClass,
            jurisdiction: output.jurisdiction,
          });
          return mapResult<BucketProps>(bucket);
        }),
        delete: Effect.fnUntraced(function* ({ output }) {
          yield* api.r2.buckets
            .delete(output.name, {
              account_id: output.accountId,
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        read: Effect.fnUntraced(function* ({ id, output, olds }) {
          const params = {
            account_id: output?.accountId ?? accountId,
            name: output?.name ?? createName(id, olds ?? {}),
          };
          return yield* api.r2.buckets
            .get(params.name, { account_id: params.account_id })
            .pipe(
              Effect.map(mapResult<BucketProps>),
              Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
            );
        }),
      };
    }),
  );
