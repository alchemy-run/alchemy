/**
 * DEPTH chain 1 — storage-compute propagation (live, doppler alchemy-v2/dev).
 *
 * One Effect-mode Function ("ChainFn") binds BOTH an Edge Config
 * (`ReadEdgeConfig`) and a blob store (`ReadWriteBlob`). The chain drives
 * five full reconciliation cycles over the same stack and asserts, per
 * cycle, what CHANGED and what STAYED STABLE:
 *
 *   1. greenfield deploy        — connection + token + both data paths live
 *   2. Edge Config item update  — data-plane only: served values change,
 *                                 deploymentId / token / connection stable
 *   3. Redacted secret rotation — Function redeploys, binding artifacts
 *                                 (token id, token value, connection id,
 *                                 BLOB_READ_WRITE_TOKEN row) stay stable
 *   4. BlobStore REPLACEMENT    — access flip public→private: successor
 *                                 store, connection re-established, token
 *                                 env re-injected, Function redeployed,
 *                                 data path works on the successor, old
 *                                 store gone
 *   5. blob binding REMOVAL     — store stays deployed but disconnects:
 *                                 BLOB_READ_WRITE_TOKEN + store captures
 *                                 removed from project env, Edge Config
 *                                 path keeps serving
 *   6. destroy                  — census-clean (project, store, config all
 *                                 verified gone out-of-band)
 *
 * Cycle-varying props ride on FQN-idempotent registration: each deploy
 * program registers "ChainFlags"/"ChainStore" with the cycle's props FIRST,
 * so the fixture's internal yields resolve to the cycle's declaration.
 * The Function generations are three fixture modules sharing one logical id.
 */
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import * as globalConfig from "@distilled.cloud/vercel/global_config";
import {
  filterProjectEnvs,
  getProject,
} from "@distilled.cloud/vercel/projects";
import {
  getStorageStoreConnections,
  getStorageStoresById,
} from "@distilled.cloud/vercel/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import ChainFn from "./fixtures/chain-fn.ts";
import ChainFnNoBlob from "./fixtures/chain-fn-noblob.ts";
import ChainFnRotated from "./fixtures/chain-fn-rotated.ts";
import { CHAIN_ITEMS_V1, CHAIN_ITEMS_V2 } from "./fixtures/chain-flags.ts";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Fresh .vercel.app URLs take a few seconds to start serving 200s — always
// retry the first request (bounded).
const readiness = Schedule.max([
  Schedule.exponential("500 millis"),
  Schedule.recurs(20),
]);

const getJson = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`status ${response.status}`)),
    ),
    Effect.retry({ schedule: readiness }),
  );

/**
 * Data-plane reads (Edge Config propagation, alias flips after redeploys)
 * are eventually consistent — poll a JSON route (bounded) until the body
 * matches.
 */
const getJsonUntil = <A>(url: string, until: (body: A) => boolean) =>
  getJson(url).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (body) => until(body as A),
      times: 20,
    }),
    Effect.map((body) => body as A),
  );

/** Poll (bounded) until the function's project is gone. */
const expectProjectGone = (projectId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const gone = yield* getProject({ idOrName: projectId, teamId }).pipe(
      Effect.map(() => false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (g) => g,
        times: 10,
      }),
    );
    expect(gone).toBe(true);
  });

/** Poll (bounded) until the blob store is gone. */
const expectStoreGone = (storeId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const gone = yield* getStorageStoresById({ id: storeId, teamId }).pipe(
      Effect.map(() => false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
      Effect.repeat({
        schedule: Schedule.spaced("2 seconds"),
        until: (g) => g,
        times: 10,
      }),
    );
    expect(gone).toBe(true);
  });

/** Poll (bounded) until the Edge Config is gone (cascades its tokens). */
const expectEdgeConfigGone = (edgeConfigId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const gone = yield* globalConfig
      .getEdgeConfig({ edgeConfigId, teamId })
      .pipe(
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (g) => g,
          times: 8,
        }),
      );
    expect(gone).toBe(true);
  });

const envRows = (projectId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const envs = yield* filterProjectEnvs({ idOrName: projectId, teamId });
    return (
      Array.isArray(envs)
        ? envs
        : typeof envs === "object" && envs !== null && "envs" in envs
          ? (envs as { envs: unknown[] }).envs
          : []
    ) as Array<{ key: string; type: string }>;
  });

/** The store's connections + the single Edge Config read token, out-of-band. */
const observeBindings = (storeId: string, edgeConfigId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const { connections } = yield* getStorageStoreConnections({
      storeId,
      teamId,
    });
    const tokens = yield* globalConfig.getEdgeConfigTokens({
      edgeConfigId,
      teamId,
    });
    return { connections, tokens };
  });

/** Per-cycle deploy program: cycle props first, then the fixture generation. */
// Generic over the fixture's own Effect type — declaring a widened
// `Effect<ChainFn>` parameter erases the class's trimorphic type and breaks
// the deploy result's attribute typing.
const cycle = <F extends Effect.Effect<any, any, any>>(opts: {
  items: Record<string, unknown>;
  access: "public" | "private";
  fn: F;
}) =>
  Effect.gen(function* () {
    // First-registration-wins: these declarations shadow the fixture-module
    // defaults for this deploy.
    const flags = yield* Vercel.EdgeConfig("ChainFlags", {
      items: { ...opts.items },
    });
    const store = yield* Vercel.BlobStore("ChainStore", {
      access: opts.access,
      // The chain deliberately replaces + destroys the store while it still
      // holds blobs — opt into the purge-on-delete path.
      forceDestroy: true,
    });
    const fn = yield* opts.fn;
    return { flags, store, fn };
  });

test.provider(
  "storage-compute propagation: item update / secret rotation / store replacement / unbind / destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // ── Cycle 1: greenfield ─────────────────────────────────────────────
      const c1 = yield* stack.deploy(
        cycle({ items: CHAIN_ITEMS_V1, access: "public", fn: ChainFn }),
      );
      expect(c1.fn.url).toBeDefined();
      expect(c1.flags.edgeConfigId).toMatch(/^ecfg_/);
      expect(c1.store.access).toEqual("public");
      // The ReadWriteBlob binding alone connected the Function's project.
      expect(c1.store.projectIds).toContain(c1.fn.projectId);

      const b1 = yield* observeBindings(
        c1.store.storeId,
        c1.flags.edgeConfigId,
      );
      expect(b1.connections.map((c) => c.projectId)).toContain(c1.fn.projectId);
      expect(b1.tokens.length).toEqual(1);
      const connectionId1 = b1.connections[0]!.id;
      const tokenId1 = b1.tokens[0]!.id;

      // Both platform-injected and capability-captured env rows landed.
      const rows1 = yield* envRows(c1.fn.projectId);
      expect(
        rows1.find((r) => r.key === "BLOB_READ_WRITE_TOKEN"),
      ).toBeDefined();
      const secretRow1 = rows1.find((r) => r.key === "CHAIN_SECRET");
      expect(secretRow1).toBeDefined();
      expect(secretRow1!.type).toEqual("sensitive");

      // Both data paths work through the deployed Function.
      const flag1 = yield* getJsonUntil<{ value: unknown }>(
        `${c1.fn.url}/flag/greeting`,
        (body) => body.value === CHAIN_ITEMS_V1.greeting,
      );
      expect(flag1.value).toEqual("chain-v1");
      const secret1 = (yield* getJson(`${c1.fn.url}/secret`)) as {
        secret: string | null;
      };
      expect(secret1.secret).toEqual("chain-secret-v1");
      const blobPath = "chain/data.txt";
      const put1 = (yield* getJson(
        `${c1.fn.url}/blob/put?path=${encodeURIComponent(blobPath)}&body=cycle1-data`,
      )) as { etag: string; url: string };
      expect(put1.url).toContain(".public.blob.vercel-storage.com");
      const got1 = (yield* getJson(
        `${c1.fn.url}/blob/get?path=${encodeURIComponent(blobPath)}`,
      )) as { text: string };
      expect(got1.text).toEqual("cycle1-data");

      // ── Cycle 2: Edge Config item update (data-plane only) ─────────────
      const c2 = yield* stack.deploy(
        cycle({ items: CHAIN_ITEMS_V2, access: "public", fn: ChainFn }),
      );
      // STABLE: physical ids and the deployment (no compute churn from an
      // item write).
      expect(c2.flags.edgeConfigId).toEqual(c1.flags.edgeConfigId);
      expect(c2.store.storeId).toEqual(c1.store.storeId);
      expect(c2.fn.projectId).toEqual(c1.fn.projectId);
      expect(c2.fn.deploymentId).toEqual(c1.fn.deploymentId);
      // CHANGED: the served values + digest.
      expect(c2.flags.digest).not.toEqual(c1.flags.digest);
      const flag2 = yield* getJsonUntil<{ value: unknown }>(
        `${c2.fn.url}/flag/greeting`,
        (body) => body.value === CHAIN_ITEMS_V2.greeting,
      );
      expect(flag2.value).toEqual("chain-v2");
      const removed = yield* getJsonUntil<{ value: unknown }>(
        `${c2.fn.url}/flag/rollout`,
        (body) => body.value === null,
      );
      expect(removed.value).toBeNull();
      const digest2 = yield* getJsonUntil<{ digest: string }>(
        `${c2.fn.url}/digest`,
        (body) => body.digest === c2.flags.digest,
      );
      expect(digest2.digest).toEqual(c2.flags.digest);
      // STABLE: token + connection untouched.
      const b2 = yield* observeBindings(
        c2.store.storeId,
        c2.flags.edgeConfigId,
      );
      expect(b2.tokens.length).toEqual(1);
      expect(b2.tokens[0]!.id).toEqual(tokenId1);
      expect(b2.connections.map((c) => c.id)).toEqual([connectionId1]);

      // ── Cycle 3: Redacted secret rotation ──────────────────────────────
      const c3 = yield* stack.deploy(
        cycle({ items: CHAIN_ITEMS_V2, access: "public", fn: ChainFnRotated }),
      );
      // CHANGED: a fresh immutable deployment (env only takes effect on new
      // deployments) serving the rotated secret.
      expect(c3.fn.projectId).toEqual(c1.fn.projectId);
      expect(c3.fn.deploymentId).not.toEqual(c2.fn.deploymentId);
      const secret3 = yield* getJsonUntil<{ secret: string | null }>(
        `${c3.fn.url}/secret`,
        (body) => body.secret === "chain-secret-v2",
      );
      expect(secret3.secret).toEqual("chain-secret-v2");
      // STABLE: every binding artifact — the Edge Config token was
      // re-observed (never re-minted), the store connection kept its id,
      // the platform token row survived, and both data paths still work.
      const b3 = yield* observeBindings(
        c3.store.storeId,
        c3.flags.edgeConfigId,
      );
      expect(b3.tokens.length).toEqual(1);
      expect(b3.tokens[0]!.id).toEqual(tokenId1);
      expect(b3.connections.map((c) => c.id)).toEqual([connectionId1]);
      const rows3 = yield* envRows(c3.fn.projectId);
      expect(
        rows3.find((r) => r.key === "BLOB_READ_WRITE_TOKEN"),
      ).toBeDefined();
      const got3 = (yield* getJson(
        `${c3.fn.url}/blob/get?path=${encodeURIComponent(blobPath)}`,
      )) as { text: string };
      expect(got3.text).toEqual("cycle1-data");
      const flag3 = (yield* getJson(`${c3.fn.url}/flag/greeting`)) as {
        value: unknown;
      };
      expect(flag3.value).toEqual("chain-v2");

      // ── Cycle 4: BlobStore REPLACEMENT (access flip public→private) ────
      const c4 = yield* stack.deploy(
        cycle({
          items: CHAIN_ITEMS_V2,
          access: "private",
          fn: ChainFnRotated,
        }),
      );
      // CHANGED: successor store, re-established connection, redeployed fn.
      expect(c4.store.storeId).not.toEqual(c3.store.storeId);
      expect(c4.store.access).toEqual("private");
      expect(c4.store.projectIds).toContain(c4.fn.projectId);
      expect(c4.fn.projectId).toEqual(c1.fn.projectId);
      expect(c4.fn.deploymentId).not.toEqual(c3.fn.deploymentId);
      // STABLE: the Edge Config side is untouched by the store replacement.
      expect(c4.flags.edgeConfigId).toEqual(c1.flags.edgeConfigId);
      const b4 = yield* observeBindings(
        c4.store.storeId,
        c4.flags.edgeConfigId,
      );
      expect(b4.tokens.length).toEqual(1);
      expect(b4.tokens[0]!.id).toEqual(tokenId1);
      // The successor's connection re-injected the token env.
      expect(b4.connections.map((c) => c.projectId)).toContain(c4.fn.projectId);
      expect(b4.connections[0]!.id).not.toEqual(connectionId1);
      const rows4 = yield* envRows(c4.fn.projectId);
      expect(
        rows4.find((r) => r.key === "BLOB_READ_WRITE_TOKEN"),
      ).toBeDefined();
      // The OLD store is gone (create-first replacement deletes it last —
      // or delete-first per the provider's diff; either way it must be gone
      // once the deploy converged).
      yield* expectStoreGone(c3.store.storeId);
      // Data path works on the successor: old content is gone with the old
      // store, fresh writes land on the private store.
      const gone4 = yield* getJsonUntil<{ notFound?: boolean }>(
        `${c4.fn.url}/blob/get?path=${encodeURIComponent(blobPath)}`,
        (body) => body.notFound === true,
      );
      expect(gone4.notFound).toBe(true);
      const put4 = (yield* getJson(
        `${c4.fn.url}/blob/put?path=${encodeURIComponent(blobPath)}&body=cycle4-data`,
      )) as { etag: string; url: string };
      expect(put4.url).toContain(".private.blob.vercel-storage.com");
      // The notFound polling above can prime a cached 404 on this pathname
      // (blob content GETs are eventually consistent for recreated
      // pathnames) — poll until the fresh write is visible.
      const got4 = yield* getJsonUntil<{ text?: string }>(
        `${c4.fn.url}/blob/get?path=${encodeURIComponent(blobPath)}`,
        (body) => body.text === "cycle4-data",
      );
      expect(got4.text).toEqual("cycle4-data");
      // Private store: the canonical URL rejects unauthenticated reads.
      const status4 = yield* HttpClient.get(put4.url).pipe(
        Effect.map((response) => response.status),
      );
      expect([401, 403]).toContain(status4);

      // ── Cycle 5: remove the blob binding (store stays deployed) ────────
      const c5 = yield* stack.deploy(
        cycle({
          items: CHAIN_ITEMS_V2,
          access: "private",
          fn: ChainFnNoBlob,
        }),
      );
      // STABLE: the store itself survives (kept in the program) and the
      // Edge Config path keeps serving through the redeployed fn.
      expect(c5.store.storeId).toEqual(c4.store.storeId);
      expect(c5.flags.edgeConfigId).toEqual(c1.flags.edgeConfigId);
      expect(c5.fn.projectId).toEqual(c1.fn.projectId);
      expect(c5.fn.deploymentId).not.toEqual(c4.fn.deploymentId);
      // CHANGED: the connection is gone…
      expect(c5.store.projectIds).toEqual([]);
      const b5 = yield* observeBindings(
        c5.store.storeId,
        c5.flags.edgeConfigId,
      );
      expect(b5.connections).toEqual([]);
      // …the platform token row and the store captures are removed…
      const rows5 = yield* envRows(c5.fn.projectId);
      expect(
        rows5.find((r) => r.key === "BLOB_READ_WRITE_TOKEN"),
      ).toBeUndefined();
      expect(
        rows5.filter((r) => r.key.toLowerCase().includes("chainstore")),
      ).toEqual([]);
      // …while the Edge Config token row + data path stay intact.
      expect(b5.tokens.length).toEqual(1);
      expect(b5.tokens[0]!.id).toEqual(tokenId1);
      const blob5 = yield* getJsonUntil<{ blob?: boolean }>(
        `${c5.fn.url}/blob/put?path=x&body=y`,
        (body) => body.blob === false,
      );
      expect(blob5.blob).toBe(false);
      const flag5 = (yield* getJson(`${c5.fn.url}/flag/greeting`)) as {
        value: unknown;
      };
      expect(flag5.value).toEqual("chain-v2");

      // ── Cycle 6: destroy — census-clean ────────────────────────────────
      yield* stack.destroy();
      yield* expectProjectGone(c1.fn.projectId);
      yield* expectStoreGone(c5.store.storeId);
      yield* expectEdgeConfigGone(c1.flags.edgeConfigId);
    }).pipe(logLevel),
  // Five sequential deploy cycles over a real Function (each redeploy is an
  // immutable Vercel deployment) + bounded data-plane polls — a chain this
  // deep cannot fit the 120s single-resource budget.
  { timeout: 420_000 },
);
