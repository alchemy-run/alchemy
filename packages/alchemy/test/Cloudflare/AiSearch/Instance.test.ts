import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as aisearch from "@distilled.cloud/cloudflare/aisearch";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, declared in the distilled error union) on the test's
// own out-of-band verification calls.
const getInstance = (accountId: string, id: string) =>
  aisearch.readInstance({ accountId, id }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const expectGone = (accountId: string, id: string) =>
  getInstance(accountId, id).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "InstanceNotDeleted" } as const)),
    // A missing instance surfaces as `NotFound` (Cloudflare error code
    // 7002) — that's the success condition here.
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "InstanceNotDeleted",
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );

// One program deploying both the R2 source bucket and the AI Search
// instance indexing it. The instance's `source` references the bucket
// name so the engine orders instance-after-bucket on deploy (and the
// reverse on destroy).
const program = (props?: Partial<Cloudflare.AiSearchInstanceProps>) =>
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2Bucket("AiSearchSource", {});
    const instance = yield* Cloudflare.AiSearchInstance("Search", {
      source: bucket.bucketName,
      ...props,
    });
    return { bucket, instance };
  });

test.provider(
  "create, update mutable props, and delete an r2-backed instance",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Create — engine-generated instance id, default settings.
      const initial = yield* stack.deploy(program());

      expect(initial.instance.id).toBeTruthy();
      expect(initial.instance.accountId).toEqual(accountId);
      expect(initial.instance.type).toEqual("r2");
      expect(initial.instance.source).toEqual(initial.bucket.bucketName);

      const live = yield* getInstance(accountId, initial.instance.id);
      expect(live.id).toEqual(initial.instance.id);
      expect(live.source).toEqual(initial.bucket.bucketName);
      expect(live.type).toEqual("r2");

      // Update mutable props in place — same instance id.
      const updated = yield* stack.deploy(
        program({
          aiSearchModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          maxNumResults: 20,
          chunkSize: 512,
          chunkOverlap: 15,
        }),
      );

      expect(updated.instance.id).toEqual(initial.instance.id);
      expect(updated.instance.aiSearchModel).toEqual(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      );

      // The update PUT returns the new settings immediately, but the
      // out-of-band read endpoint reflects them eventually-consistently (it
      // briefly serves `aiSearchModel: ""` right after the write). Poll the
      // readback until the mutated props land before asserting, bounded.
      const liveUpdated = yield* getInstance(
        accountId,
        updated.instance.id,
      ).pipe(
        Effect.flatMap((live) =>
          live.aiSearchModel === "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
            ? Effect.succeed(live)
            : Effect.fail({ _tag: "InstanceUpdateNotApplied" } as const),
        ),
        Effect.retry({
          while: (e) => e._tag === "InstanceUpdateNotApplied",
          schedule: Schedule.spaced("3 seconds"),
          times: 20,
        }),
      );
      expect(liveUpdated.aiSearchModel).toEqual(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      );
      expect(liveUpdated.maxNumResults).toEqual(20);
      expect(liveUpdated.chunkSize).toEqual(512);
      expect(liveUpdated.chunkOverlap).toEqual(15);

      // Redeploying identical props is a no-op (still the same instance).
      const noop = yield* stack.deploy(
        program({
          aiSearchModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          maxNumResults: 20,
          chunkSize: 512,
          chunkOverlap: 15,
        }),
      );
      expect(noop.instance.id).toEqual(initial.instance.id);

      yield* stack.destroy();

      yield* expectGone(accountId, initial.instance.id);

      // Destroy again — delete must be idempotent (already gone).
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "changing the embedding model triggers a replacement",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        program({ embeddingModel: "@cf/baai/bge-m3" }),
      );
      expect(initial.instance.embeddingModel).toEqual("@cf/baai/bge-m3");

      const replaced = yield* stack.deploy(
        program({ embeddingModel: "@cf/baai/bge-large-en-v1.5" }),
      );

      // The embedding model defines the vector space and is fixed at
      // creation — a new physical instance exists.
      expect(replaced.instance.id).not.toEqual(initial.instance.id);
      expect(replaced.instance.embeddingModel).toEqual(
        "@cf/baai/bge-large-en-v1.5",
      );

      const live = yield* getInstance(accountId, replaced.instance.id);
      expect(live.embeddingModel).toEqual("@cf/baai/bge-large-en-v1.5");

      // The old instance was deleted as part of the replacement.
      yield* expectGone(accountId, initial.instance.id);

      yield* stack.destroy();

      yield* expectGone(accountId, replaced.instance.id);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "recreates after out-of-band delete",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const initial = yield* stack.deploy(program());

      // Delete the instance out-of-band. A redeploy with identical props is
      // a planner no-op, so change a mutable prop to force reconcile — it
      // must observe the instance as missing and recreate it instead of
      // failing on a 404.
      yield* aisearch
        .deleteInstance({ accountId, id: initial.instance.id })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: Schedule.exponential("500 millis"),
            times: 8,
          }),
        );
      yield* expectGone(accountId, initial.instance.id);

      const healed = yield* stack.deploy(program({ maxNumResults: 10 }));

      expect(healed.instance.id).toEqual(initial.instance.id);
      const live = yield* getInstance(accountId, healed.instance.id);
      expect(live.id).toEqual(initial.instance.id);

      yield* stack.destroy();

      yield* expectGone(accountId, healed.instance.id);
    }).pipe(logLevel),
  { timeout: 240_000 },
);

// Canonical `list()` test (account collection): `list()` enumerates every
// AI Search instance in the account via `listInstances`, paginating
// exhaustively, and hydrates each into the `read` Attributes shape. Deploy
// an instance and assert its id appears in the result.
test.provider(
  "list enumerates the deployed instance",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(program());

      const provider = yield* Provider.findProvider(
        Cloudflare.AiSearchInstance,
      );
      const all = yield* provider.list();

      expect(all.some((x) => x.id === deployed.instance.id)).toBe(true);

      yield* stack.destroy();

      yield* expectGone(deployed.instance.accountId, deployed.instance.id);
    }).pipe(logLevel),
  { timeout: 240_000 },
);
