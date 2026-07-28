import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import * as d1 from "@distilled.cloud/cloudflare/d1";
import * as kv from "@distilled.cloud/cloudflare/kv";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import { inDev } from "../test.resources.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * Dev → deploy promotion, end-to-end against the real cloud: a stack first
 * deployed under `alchemy dev` (KV / R2 / D1 as local `dev:` rows, zero
 * cloud calls) is then deployed live. The engine plans a mode-switch
 * REPLACEMENT for each resource: the live provider creates the real cloud
 * resource, and the local provider (the stamped mode that created the old
 * generation) deletes the dev row without touching the cloud. Destroy then
 * removes the real resources.
 */
test.provider(
  "dev-mode KV/R2/D1 promote to live cloud resources on deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = Effect.gen(function* () {
        const namespace = yield* Cloudflare.KV.Namespace("PromotedKV");
        const bucket = yield* Cloudflare.R2.Bucket("PromotedBucket");
        const database = yield* Cloudflare.D1.Database("PromotedDB");
        return { namespace, bucket, database };
      });

      // 1. dev run — every resource is a local `dev:` row.
      const dev = yield* inDev(stack.deploy(program));
      expect(dev.namespace.namespaceId).toMatch(/^dev:/);
      expect(dev.bucket.bucketName).toMatch(/^dev:/);
      expect(dev.database.databaseId).toMatch(/^dev:/);

      // 2. plain (live) deploy of the SAME program — the stamped-mode
      // mismatch plans replacements; the live providers create real
      // resources and the identities change.
      const live = yield* stack.deploy(program);
      expect(live.namespace.namespaceId).not.toMatch(/^dev:/);
      expect(live.bucket.bucketName).not.toMatch(/^dev:/);
      expect(live.database.databaseId).not.toMatch(/^dev:/);

      // Out-of-band: all three exist on Cloudflare.
      const { accountId } = yield* yield* CloudflareEnvironment;
      const namespace = yield* kv.getNamespace({
        accountId,
        namespaceId: live.namespace.namespaceId,
      });
      expect(namespace.id).toBe(live.namespace.namespaceId);
      const bucket = yield* r2.getBucket({
        accountId,
        bucketName: live.bucket.bucketName,
      });
      expect(bucket.name).toBe(live.bucket.bucketName);
      const database = yield* d1.getDatabase({
        accountId,
        databaseId: live.database.databaseId,
      });
      expect(database.uuid).toBe(live.database.databaseId);

      // 3. destroy tears the real resources down (live-stamped rows).
      yield* stack.destroy();
      const gone = yield* Effect.all([
        kv
          .getNamespace({
            accountId,
            namespaceId: live.namespace.namespaceId,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("NamespaceNotFound", () => Effect.succeed(true)),
          ),
        r2.getBucket({ accountId, bucketName: live.bucket.bucketName }).pipe(
          Effect.as(false),
          Effect.catchTag("NoSuchBucket", () => Effect.succeed(true)),
        ),
        d1
          .getDatabase({ accountId, databaseId: live.database.databaseId })
          .pipe(
            Effect.as(false),
            Effect.catchTag("DatabaseNotFound", () => Effect.succeed(true)),
          ),
      ]);
      expect(gone).toEqual([true, true, true]);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
