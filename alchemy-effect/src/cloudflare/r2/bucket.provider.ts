import type { R2 } from "cloudflare/resources";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../physical-name.ts";
import { Account } from "../account.ts";
import { CloudflareApi } from "../api";
import { Bucket, type BucketAttr, type BucketProps } from "./bucket";

export const bucketProvider = () =>
  Bucket.provider.effect(
    Effect.gen(function* () {
      const api = yield* CloudflareApi;
      const accountId = yield* Account;

      const createName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          if (name) return name;
          return (yield* createPhysicalName({ id })).toLowerCase();
        });

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
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          const name = yield* createName(id, news.name);
          if (
            output.accountId !== accountId ||
            output.name !== name ||
            output.jurisdiction !== (news.jurisdiction ?? "default") ||
            olds.locationHint !== news.locationHint
          ) {
            return { action: "replace" };
          }
          if (output.storageClass !== (news.storageClass ?? "Standard")) {
            return {
              action: "update",
              stables: output.name === name ? ["name"] : undefined,
            };
          }
          return { action: "noop" };
        }),
        create: Effect.fnUntraced(function* ({ id, news }) {
          const name = yield* createName(id, news.name);
          const bucket = yield* api.r2.buckets.create({
            account_id: accountId,
            name,
            storageClass: news.storageClass,
            jurisdiction: news.jurisdiction,
            locationHint: news.locationHint,
          });
          return mapResult<BucketProps>(bucket);
        }),
        update: Effect.fnUntraced(function* ({ news, output }) {
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
          const name = output?.name ?? (yield* createName(id, olds?.name));
          const params = {
            account_id: output?.accountId ?? accountId,
            name,
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
