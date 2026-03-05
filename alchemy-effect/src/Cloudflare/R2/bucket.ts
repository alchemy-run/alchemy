import * as r2 from "distilled-cloudflare/r2";
import * as Effect from "effect/Effect";

import { createPhysicalName } from "../../PhysicalName.ts";
import { Resource } from "../../Resource.ts";
import { Account } from "../Account.ts";

export type BucketName = string;

export type BucketProps = {
  /**
   * Name of the bucket. If omitted, a unique name will be generated.
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * Storage class for newly uploaded objects.
   * @default "Standard"
   */
  storageClass?: Bucket.StorageClass;
  /**
   * Jurisdiction where objects in this bucket are guaranteed to be stored.
   * @default "default"
   */
  jurisdiction?: Bucket.Jurisdiction;
  /**
   * Location hint for the bucket.
   */
  locationHint?: Bucket.Location;
};

export interface Bucket extends Resource<
  "Cloudflare.R2.Bucket",
  BucketProps,
  {
    bucketName: BucketName;
    storageClass: Bucket.StorageClass;
    jurisdiction: Bucket.Jurisdiction;
    location: Bucket.Location | undefined;
    accountId: string;
  }
> {}

export const Bucket = Resource<Bucket>("Cloudflare.R2.Bucket");

export declare namespace Bucket {
  export type StorageClass = "Standard" | "InfrequentAccess";
  export type Jurisdiction = "default" | "eu" | "fedramp";
  export type Location = "apac" | "eeur" | "enam" | "weur" | "wnam" | "oc";
}

export const BucketProvider = () =>
  Bucket.provider.effect(
    Effect.gen(function* () {
      const accountId = yield* Account;
      const createBucket = yield* r2.createBucket;
      const patchBucket = yield* r2.patchBucket;
      const deleteBucket = yield* r2.deleteBucket;
      const getBucket = yield* r2.getBucket;

      const createBucketName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          if (name) return name;
          return (yield* createPhysicalName({
            id,
            maxLength: 63,
          })).toLowerCase();
        });

      const normalizeLocation = (
        location: string | undefined,
      ): Bucket.Location | undefined => {
        if (!location) return undefined;
        return location.toLowerCase() as Bucket.Location;
      };

      return {
        stables: ["bucketName", "accountId"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
          const name = yield* createBucketName(id, news.name);
          if (
            output.accountId !== accountId ||
            output.bucketName !== name ||
            output.jurisdiction !== (news.jurisdiction ?? "default") ||
            olds.locationHint !== news.locationHint
          ) {
            return { action: "replace" } as const;
          }
          if (output.storageClass !== (news.storageClass ?? "Standard")) {
            return {
              action: "update",
              stables: output.bucketName === name ? ["bucketName"] : undefined,
            } as const;
          }
        }),
        create: Effect.fn(function* ({ id, news = {} }) {
          const name = yield* createBucketName(id, news.name);
          const bucket = yield* createBucket({
            accountId,
            name,
            storageClass: news.storageClass,
            jurisdiction: news.jurisdiction,
            locationHint: news.locationHint,
          }).pipe(
            Effect.catchTag("BucketAlreadyExists", () =>
              getBucket({
                accountId,
                bucketName: name,
                jurisdiction: news.jurisdiction,
              }),
            ),
          );
          return {
            bucketName: bucket.name!,
            storageClass: bucket.storageClass ?? "Standard",
            jurisdiction: bucket.jurisdiction ?? "default",
            location: normalizeLocation(bucket.location),
            accountId,
          };
        }),
        update: Effect.fn(function* ({ news = {}, output }) {
          const bucket = yield* patchBucket({
            accountId: output.accountId,
            bucketName: output.bucketName,
            storageClass: news.storageClass ?? output.storageClass,
            jurisdiction: output.jurisdiction,
          });
          return {
            bucketName: bucket.name!,
            storageClass: bucket.storageClass ?? "Standard",
            jurisdiction: bucket.jurisdiction ?? "default",
            location: normalizeLocation(bucket.location),
            accountId: output.accountId,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteBucket({
            accountId: output.accountId,
            bucketName: output.bucketName,
            jurisdiction: output.jurisdiction,
          }).pipe(Effect.catchTag("NoSuchBucket", () => Effect.void));
        }),
        read: Effect.fn(function* ({ id, output, olds }) {
          const name =
            output?.bucketName ?? (yield* createBucketName(id, olds?.name));
          const acct = output?.accountId ?? accountId;
          return yield* getBucket({
            accountId: acct,
            bucketName: name,
            jurisdiction: output?.jurisdiction ?? olds?.jurisdiction,
          }).pipe(
            Effect.map((bucket) => ({
              bucketName: bucket.name!,
              storageClass: bucket.storageClass ?? "Standard",
              jurisdiction: bucket.jurisdiction ?? "default",
              location: normalizeLocation(bucket.location),
              accountId: acct,
            })),
            Effect.catchTag("NoSuchBucket", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );
