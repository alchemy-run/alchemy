import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { AlchemyContext } from "@/AlchemyContext.ts";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import { localRuntimeServices } from "@/Cloudflare/LocalRuntime.ts";
import type { CloudflareResolvedCredentials } from "@/Cloudflare/Auth/AuthProvider.ts";
import { AlchemyProfile, type ProfileService } from "@/Auth/Profile.ts";

/**
 * The local-mode account-drift rule, end to end through plan/apply:
 *
 * - a local row stamped `accountId: undefined` (created credential-free)
 *   is NEVER replaced when credentials later become available — the first
 *   deploy after `alchemy login` must not wipe local data;
 * - once an account IS stamped, switching to a *different* account
 *   replaces the local resource (fresh identity, fresh data);
 * - un-stamped siblings are untouched by the switch.
 *
 * Credential state is simulated with a mutable `CloudflareEnvironment` +
 * `AlchemyProfile` override pair: `currentCreds === undefined` models the
 * logged-out state (profile unconfigured, forcing dies), a value models a
 * logged-in account. The overrides only reach providers running in this
 * process, so the suite uses `sidecar: false` (in-process dev — the same
 * path a plain `alchemy deploy` takes when touching local-mode rows) and a
 * plain (non-RPC) local provider, KV.
 */

const ACCOUNT_A = "a".repeat(32);
const ACCOUNT_B = "b".repeat(32);

const makeCreds = (accountId: string): CloudflareResolvedCredentials => ({
  type: "apiToken",
  apiToken: Redacted.make("test-token"),
  accountId,
  source: { type: "env" },
});

let currentCreds: CloudflareResolvedCredentials | undefined;

const envOverride = Layer.succeed(
  CloudflareEnvironment,
  CloudflareEnvironment.of(
    Effect.suspend(() =>
      currentCreds !== undefined
        ? Effect.succeed(currentCreds)
        : Effect.die(
            new Error(
              "CloudflareEnvironment was forced during a credential-free local run",
            ),
          ),
    ),
  ),
);

const profileOverride = Layer.succeed(
  AlchemyProfile,
  AlchemyProfile.of({
    readConfig: Effect.sync(() => ({
      version: 0 as const,
      profiles: {},
    })),
    writeConfig: () => Effect.void,
    getProfile: () =>
      Effect.sync(() =>
        currentCreds !== undefined
          ? { Cloudflare: { method: "env" } }
          : undefined,
      ),
    setProfile: () => Effect.void,
    deleteProfile: () => Effect.succeed(false),
    loadOrConfigure: () =>
      Effect.die(
        new Error(
          "loadOrConfigure was called during a credential-free local run",
        ),
      ),
  } satisfies ProfileService),
);

const { test } = Test.make({
  providers: Layer.mergeAll(envOverride, profileOverride).pipe(
    Layer.provideMerge(Cloudflare.providers()),
  ),
  dev: true,
  sidecar: false,
});

/**
 * Guard-rail for the eager local-variant build (`ProviderLayer.dual`
 * builds the run-default variant eagerly in dev): the shared local-runtime
 * dependency layer must BUILD against a `CloudflareEnvironment` whose
 * resolution dies on force — construction is credential-free today; pin it.
 * (The `accountId` handed to the runtime is a deferred effect, only forced
 * if the runtime actually needs the account for a remote call.)
 */
test(
  "localRuntimeServices builds against a CloudflareEnvironment that dies on force",
  Effect.gen(function* () {
    currentCreds = undefined;
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectory({ prefix: "alchemy-credfree-" });
    const context = yield* Layer.build(
      localRuntimeServices() as Layer.Layer<unknown, unknown, never>,
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          envOverride,
          Layer.succeed(AlchemyContext, {
            dotAlchemy: dir,
            dev: true,
            adopt: false,
          }),
        ),
      ),
      Effect.scoped,
    );
    expect(context).toBeDefined();
  }),
  { timeout: 60_000 },
);

test.provider(
  "login after a credential-free deploy is a noop; a real account switch replaces",
  (stack) =>
    Effect.gen(function* () {
      currentCreds = undefined;
      yield* stack.destroy();

      const makeStack = (kvTitle?: string) =>
        Effect.gen(function* () {
          const kv = yield* Cloudflare.KV.Namespace(
            "DriftKV",
            kvTitle === undefined ? {} : { title: kvTitle },
          );
          // A sibling that stays un-stamped for the whole test — the
          // account switch in the final phase must not touch it.
          const bucket = yield* Cloudflare.R2.Bucket("DriftBucket");
          return { kv, bucket };
        });

      // ── Phase 1: credential-free create — nothing stamped ─────────────
      const v1 = yield* stack.deploy(makeStack());
      expect(v1.kv.namespaceId).toMatch(/^dev:/);
      expect(v1.kv.accountId).toBeUndefined();
      expect(v1.bucket.accountId).toBeUndefined();

      // ── Phase 2: "the user logs in" — the first credentialed deploy is
      // a NOOP, never a replacement (undefined matches any account) ──────
      currentCreds = makeCreds(ACCOUNT_A);
      const v2 = yield* stack.deploy(makeStack());
      expect(v2.kv.namespaceId).toBe(v1.kv.namespaceId);
      expect(v2.bucket.bucketName).toBe(v1.bucket.bucketName);
      // A noop keeps the persisted attributes — still un-stamped.
      expect(v2.kv.accountId).toBeUndefined();

      // ── Phase 3: an unrelated prop change updates in place and stamps
      // the now-known account opportunistically ──────────────────────────
      const v3 = yield* stack.deploy(makeStack("drift-kv-renamed"));
      expect(v3.kv.namespaceId).toBe(v1.kv.namespaceId);
      expect(v3.kv.title).toBe("drift-kv-renamed");
      expect(v3.kv.accountId).toBe(ACCOUNT_A);

      // ── Phase 4: a REAL account switch (both sides known + different)
      // replaces the stamped resource; the un-stamped sibling is untouched
      currentCreds = makeCreds(ACCOUNT_B);
      const v4 = yield* stack.deploy(makeStack("drift-kv-renamed"));
      expect(v4.kv.namespaceId).not.toBe(v3.kv.namespaceId);
      expect(v4.kv.namespaceId).toMatch(/^dev:/);
      expect(v4.kv.accountId).toBe(ACCOUNT_B);
      expect(v4.bucket.bucketName).toBe(v1.bucket.bucketName);
      expect(v4.bucket.accountId).toBeUndefined();

      // ── Teardown: destroy must work logged-out again ──────────────────
      currentCreds = undefined;
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
