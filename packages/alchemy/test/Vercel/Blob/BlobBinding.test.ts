/**
 * Vercel Blob capability binding tests — live against the standing Vercel
 * test team (run with the doppler alchemy-v2/dev env).
 *
 * Covers: the Effect-mode `ReadWriteBlob`/`ReadBlob` bindings (the binding
 * alone connects the Function's project to the store, which makes the
 * platform inject `BLOB_READ_WRITE_TOKEN`), the full data-plane round trip
 * over the deployed function (put → get → head → list → CAS 412 →
 * conditional-create 400 → del), redeploy stability of the captured env,
 * and the async-mode `readWriteBlobFromEnv` client against a PRIVATE store
 * connected through the store's binding contract from stack composition.
 */
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
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
import BlobFn from "./fixtures/blob-worker.ts";
import { Uploads } from "./fixtures/uploads-store.ts";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const asyncFixtureMain = new URL(
  "./fixtures/async-blob-handler.ts",
  import.meta.url,
).pathname;

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

/** Poll (bounded) until the project is gone. */
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

const envKeys = (envs: unknown): Array<{ key: string; type: string }> =>
  (Array.isArray(envs)
    ? envs
    : typeof envs === "object" && envs !== null && "envs" in envs
      ? (envs as { envs: unknown[] }).envs
      : []) as Array<{ key: string; type: string }>;

test.provider(
  "effect-mode ReadWriteBlob/ReadBlob: binding connects the project, data plane round-trips",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { fn, store } = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* BlobFn;
          const store = yield* Uploads;
          return { fn, store };
        }),
      );
      expect(fn.url).toBeDefined();
      expect(store.storeId).toBeDefined();
      expect(store.access).toEqual("public");

      // 1. The BINDING (no `projects:` prop) connected the Function's
      //    project to the store.
      expect(store.projectIds).toContain(fn.projectId);
      const { teamId } = yield* Vercel.VercelEnvironment.current;
      const connections = yield* getStorageStoreConnections({
        storeId: store.storeId,
        teamId,
      });
      expect(connections.connections.map((c) => c.projectId)).toContain(
        fn.projectId,
      );

      // 2. ... which injected the platform token env into the project.
      const envs = yield* filterProjectEnvs({
        idOrName: fn.projectId,
        teamId,
      });
      const tokenRow = envKeys(envs).find(
        (row) => row.key === "BLOB_READ_WRITE_TOKEN",
      );
      expect(tokenRow).toBeDefined();

      // 3. Data-plane round trip through the deployed function.
      const path = "cap/hello.txt";
      const put = (yield* getJson(
        `${fn.url}/blob/put?path=${encodeURIComponent(path)}&body=hello-v1`,
      )) as { etag: string; url: string; pathname: string };
      expect(put.pathname).toEqual(path);
      expect(put.etag).toBeDefined();
      // Public store: the canonical URL host carries the lowercased bare
      // store id + access mode, and serves unauthenticated reads.
      expect(put.url).toContain(".public.blob.vercel-storage.com");
      const raw = yield* HttpClient.get(put.url).pipe(
        Effect.flatMap((response) => response.text),
      );
      expect(raw).toEqual("hello-v1");

      const got = (yield* getJson(
        `${fn.url}/blob/get?path=${encodeURIComponent(path)}`,
      )) as { text: string };
      expect(got.text).toEqual("hello-v1");

      const head = (yield* getJson(
        `${fn.url}/blob/head?path=${encodeURIComponent(path)}`,
      )) as { size: number; etag: string };
      expect(head.size).toEqual("hello-v1".length);
      expect(head.etag).toEqual(put.etag);

      // 4. Conditional create on an existing pathname → typed AlreadyExists.
      const create = (yield* getJson(
        `${fn.url}/blob/create?path=${encodeURIComponent(path)}&body=x`,
      )) as { alreadyExists?: boolean };
      expect(create.alreadyExists).toBe(true);

      // 5. CAS: wrong etag → typed PreconditionFailed; right etag → 200.
      const casWrong = (yield* getJson(
        `${fn.url}/blob/cas?path=${encodeURIComponent(path)}&body=hello-v2&etag=${encodeURIComponent('"wrong-etag"')}`,
      )) as { precondition?: boolean };
      expect(casWrong.precondition).toBe(true);
      const casRight = (yield* getJson(
        `${fn.url}/blob/cas?path=${encodeURIComponent(path)}&body=hello-v2&etag=${encodeURIComponent(put.etag)}`,
      )) as { etag?: string };
      expect(casRight.etag).toBeDefined();
      expect(casRight.etag).not.toEqual(put.etag);

      // 6. List sees the blob; the read-only client reads the new content.
      const listed = (yield* getJson(
        `${fn.url}/blob/list?prefix=${encodeURIComponent("cap/")}`,
      )) as { pathnames: string[] };
      expect(listed.pathnames).toContain(path);
      const readOnly = (yield* getJson(
        `${fn.url}/blob/read?path=${encodeURIComponent(path)}`,
      )) as { text: string };
      expect(readOnly.text).toEqual("hello-v2");

      // 7. Delete, then the typed NotFound surfaces on get.
      const del = (yield* getJson(
        `${fn.url}/blob/del?path=${encodeURIComponent(path)}`,
      )) as { ok: boolean };
      expect(del.ok).toBe(true);
      const gone = (yield* getJson(
        `${fn.url}/blob/get?path=${encodeURIComponent(path)}`,
      )) as { notFound?: boolean };
      expect(gone.notFound).toBe(true);

      // 8. Churn regression: an identical redeploy is a skip-on-hash no-op —
      //    the captured store accessors and the connection are stable.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* BlobFn;
          const store = yield* Uploads;
          return { fn, store };
        }),
      );
      expect(redeployed.fn.projectId).toEqual(fn.projectId);
      expect(redeployed.fn.deploymentId).toEqual(fn.deploymentId);

      // 9. Destroy cascades the project AND the store; typed wait-until-gone.
      yield* stack.destroy();
      yield* expectProjectGone(fn.projectId);
      yield* expectStoreGone(store.storeId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "async-mode readWriteBlobFromEnv against a private store (binding-contract connect from composition)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { fn, store } = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* Vercel.BlobStore("AsyncBlobStore", {
            access: "private",
          });
          const fn = yield* Vercel.Function("AsyncBlobFn", {
            main: asyncFixtureMain,
            // The env ref creates the fn → store dependency edge, so the
            // connection (and its injected token env) lands BEFORE the
            // deployment is created — project env only takes effect on new
            // deployments.
            env: { BLOB_STORE_ID: store.storeId },
          });
          // Connect the Function's project through the store's binding
          // contract (what the Effect-mode capability does under the hood).
          yield* store.bind("AsyncBlobFn", { projects: [fn.projectId] });
          return { fn, store };
        }),
      );
      expect(store.access).toEqual("private");
      expect(store.projectIds).toContain(fn.projectId);

      // The platform injected the token into the project.
      const { teamId } = yield* Vercel.VercelEnvironment.current;
      const envs = yield* filterProjectEnvs({
        idOrName: fn.projectId,
        teamId,
      });
      expect(
        envKeys(envs).find((row) => row.key === "BLOB_READ_WRITE_TOKEN"),
      ).toBeDefined();

      // put → get through the deployed async handler (promise client).
      const path = "async/p.txt";
      const put = (yield* getJson(
        `${fn.url}/put?path=${encodeURIComponent(path)}&body=private-hello`,
      )) as { etag: string; url: string };
      expect(put.etag).toBeDefined();
      expect(put.url).toContain(".private.blob.vercel-storage.com");

      const got = (yield* getJson(
        `${fn.url}/get?path=${encodeURIComponent(path)}`,
      )) as { text: string };
      expect(got.text).toEqual("private-hello");

      // Private store: the canonical URL rejects unauthenticated reads.
      const status = yield* HttpClient.get(put.url).pipe(
        Effect.map((response) => response.status),
      );
      expect([401, 403]).toContain(status);

      // Cleanup the blob, then the stack (project + store), typed
      // wait-until-gone.
      const del = (yield* getJson(
        `${fn.url}/del?path=${encodeURIComponent(path)}`,
      )) as { ok: boolean };
      expect(del.ok).toBe(true);

      yield* stack.destroy();
      yield* expectProjectGone(fn.projectId);
      yield* expectStoreGone(store.storeId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);
