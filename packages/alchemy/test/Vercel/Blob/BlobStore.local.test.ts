/**
 * Vercel BlobStore dev-mode (`alchemy dev`) tests — the local provider per
 * the Local-tests doctrine: `dev: true` runs local providers behind the
 * RPC sidecar proxy by default, matching the process topology of the real
 * `alchemy dev` command.
 *
 * Covers (a) the local roundtrip: a `dev:store_…` row (proof no cloud call
 * ran), the Effect-mode `ReadWriteBlob`/`ReadBlob` bindings driven through
 * a locally-running Function against the directory-backed emulator —
 * put → content URL fetch → get → head → conditional-create 400-equivalent
 * (typed `Vercel.Blob.AlreadyExists`) → CAS 412-equivalent (typed
 * `Vercel.Blob.PreconditionFailed`) → list → del — plus an out-of-band
 * check from the test process via the async `readWriteBlobFromEnv` client
 * pointed at the emulator through the store's `localApiUrl`/`localToken`
 * attributes; and (b) the `Alchemy.remote()` opt-out deploying the store
 * live during dev with out-of-band distilled verification and post-destroy
 * absence (pins the stamped-mode delete path).
 */
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import { getProject } from "@distilled.cloud/vercel/projects";
import { getStorageStoresById } from "@distilled.cloud/vercel/storage";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import BlobFn from "./fixtures/blob-worker.ts";
import { Uploads } from "./fixtures/uploads-store.ts";

const { test } = Test.make({
  providers: Vercel.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const asyncFixtureMain = new URL(
  "./fixtures/async-blob-handler.ts",
  import.meta.url,
).pathname;

class NotReady extends Data.TaggedError("NotReady")<{
  status: number;
  location: string | undefined;
  message: string;
}> {}

// The first request races the dev bundle's first build (rolldown over the
// alchemy barrel for Effect functions) — retry with a bounded cap.
const readiness = Schedule.max([
  Schedule.min([
    Schedule.exponential("500 millis"),
    Schedule.spaced("2 seconds"),
  ]),
  Schedule.recurs(45),
]);

const getJsonReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(
              new NotReady({
                status: res.status,
                location: res.headers.location,
                message: `GET ${url} -> ${res.status}${
                  res.headers.location
                    ? ` (location: ${res.headers.location})`
                    : ""
                }`,
              }),
            ),
      ),
      Effect.retry({
        while: (e): e is NotReady => e instanceof NotReady,
        schedule: readiness,
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

test.provider(
  "local roundtrip: dev store markers, ReadWriteBlob through a local Function, CAS + conditional create",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const client = yield* HttpClient.HttpClient;

      const { fn, store } = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* BlobFn;
          const store = yield* Uploads;
          return { fn, store };
        }),
      );

      // dev identity markers — proof no cloud call ran.
      expect(store.storeId).toMatch(/^dev:store_/);
      expect(store.localApiUrl).toMatch(/^http:\/\/localhost:\d+$/);
      expect(store.localToken).toBeDefined();
      expect(fn.url).toMatch(/^http:\/\/localhost:\d+$/);
      expect(fn.projectId).toMatch(/^dev:/);

      // put through the local Function's ReadWriteBlob binding; the
      // returned content URL points at the emulator, not the platform.
      const path = "cap/hello.txt";
      const put = (yield* getJsonReady(
        `${fn.url}/blob/put?path=${encodeURIComponent(path)}&body=hello-v1`,
      )) as { etag: string; url: string; pathname: string };
      expect(put.pathname).toEqual(path);
      expect(put.etag).toBeDefined();
      expect(put.url.startsWith(`${store.localApiUrl}/`)).toBe(true);

      // Public store: the content URL serves unauthenticated reads.
      const raw = yield* client
        .get(put.url)
        .pipe(Effect.flatMap((response) => response.text));
      expect(raw).toEqual("hello-v1");

      const got = (yield* getJsonReady(
        `${fn.url}/blob/get?path=${encodeURIComponent(path)}`,
      )) as { text: string };
      expect(got.text).toEqual("hello-v1");

      const head = (yield* getJsonReady(
        `${fn.url}/blob/head?path=${encodeURIComponent(path)}`,
      )) as { size: number; etag: string };
      expect(head.size).toEqual("hello-v1".length);
      expect(head.etag).toEqual(put.etag);

      // Conditional create on an existing pathname → typed AlreadyExists
      // (the emulator mirrors the wire's 400 "already exists").
      const create = (yield* getJsonReady(
        `${fn.url}/blob/create?path=${encodeURIComponent(path)}&body=x`,
      )) as { alreadyExists?: boolean };
      expect(create.alreadyExists).toBe(true);

      // CAS: wrong etag → typed PreconditionFailed (wire 412); right → 200.
      const casWrong = (yield* getJsonReady(
        `${fn.url}/blob/cas?path=${encodeURIComponent(path)}&body=hello-v2&etag=${encodeURIComponent('"wrong-etag"')}`,
      )) as { precondition?: boolean };
      expect(casWrong.precondition).toBe(true);
      const casRight = (yield* getJsonReady(
        `${fn.url}/blob/cas?path=${encodeURIComponent(path)}&body=hello-v2&etag=${encodeURIComponent(put.etag)}`,
      )) as { etag?: string };
      expect(casRight.etag).toBeDefined();
      expect(casRight.etag).not.toEqual(put.etag);

      // List sees the blob; the read-only client reads the new content.
      const listed = (yield* getJsonReady(
        `${fn.url}/blob/list?prefix=${encodeURIComponent("cap/")}`,
      )) as { pathnames: string[] };
      expect(listed.pathnames).toContain(path);
      const readOnly = (yield* getJsonReady(
        `${fn.url}/blob/read?path=${encodeURIComponent(path)}`,
      )) as { text: string };
      expect(readOnly.text).toEqual("hello-v2");

      // Out-of-band from the TEST process: the async promise client pointed
      // at the emulator via the store's dev attributes reads the same data
      // plane the Function wrote to (also proves `@vercel/blob`-style env
      // clients work against the emulator).
      const outOfBand = Vercel.readWriteBlobFromEnv({
        token: Redacted.value(store.localToken!),
        apiUrl: store.localApiUrl,
        access: "public",
      });
      const oob = yield* Effect.promise(() => outOfBand.get(path));
      expect(oob.text).toEqual("hello-v2");

      // Delete, then the typed NotFound surfaces on get.
      const del = (yield* getJsonReady(
        `${fn.url}/blob/del?path=${encodeURIComponent(path)}`,
      )) as { ok: boolean };
      expect(del.ok).toBe(true);
      const gone = (yield* getJsonReady(
        `${fn.url}/blob/get?path=${encodeURIComponent(path)}`,
      )) as { notFound?: boolean };
      expect(gone.notFound).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "Alchemy.remote() store + Function deploy live during dev",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { fn, store } = yield* stack.deploy(
        Effect.gen(function* () {
          // The platform injects the token through the store↔project
          // connection, so a live store needs a live project — pipe BOTH
          // through remote(). (A local Function against a remote store is
          // structurally impossible: the platform cannot inject the token
          // into a project that doesn't exist.)
          const store = yield* Vercel.BlobStore("RemoteBlobStore", {
            access: "private",
          }).pipe(Alchemy.remote());
          // The env ref creates the fn → store dependency edge, so the
          // connection (and its injected `BLOB_READ_WRITE_TOKEN`) lands
          // BEFORE the deployment is created — project env only takes
          // effect on new deployments. Safe in the cycle: `precreate`
          // strips the env channel before its resolved-props gate, so the
          // stub still creates the real project for the store to connect.
          // (Same shape as the live BlobBinding.test.ts async case.)
          const fn = yield* Vercel.Function("RemoteBlobFn", {
            main: asyncFixtureMain,
            env: { BLOB_STORE_ID: store.storeId },
          }).pipe(Alchemy.remote());
          yield* store.bind("RemoteBlobFn", { projects: [fn.projectId] });
          return { fn, store };
        }),
      );

      // Real cloud identity — not the local emulator.
      expect(store.storeId).toMatch(/^store_/);
      expect(store.localApiUrl).toBeUndefined();
      expect(fn.url).toMatch(/^https:\/\//);
      expect(store.projectIds).toContain(fn.projectId);

      // Round-trip against the real data plane through the deployment.
      const path = "remote/p.txt";
      const put = (yield* getJsonReady(
        `${fn.url}/put?path=${encodeURIComponent(path)}&body=remote-hello`,
      )) as { etag: string; url: string };
      expect(put.url).toContain(".private.blob.vercel-storage.com");
      const got = (yield* getJsonReady(
        `${fn.url}/get?path=${encodeURIComponent(path)}`,
      )) as { text: string };
      expect(got.text).toEqual("remote-hello");

      // Out-of-band via distilled: the store exists on real Vercel.
      const { teamId } = yield* Vercel.VercelEnvironment.current;
      const found = yield* getStorageStoresById({
        id: store.storeId,
        teamId,
      });
      expect(found.store.id).toEqual(store.storeId);

      // Clean the blob so the store delete does not 409 `not_empty`.
      const del = (yield* getJsonReady(
        `${fn.url}/del?path=${encodeURIComponent(path)}`,
      )) as { ok: boolean };
      expect(del.ok).toBe(true);

      yield* stack.destroy();

      // The live store AND project were deleted from the cloud on destroy
      // (rows stamped live, so the live provider handles the deletes even
      // in a dev run) — typed wait-until-gone.
      const storeGone = yield* getStorageStoresById({
        id: store.storeId,
        teamId,
      }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (g) => g,
          times: 10,
        }),
      );
      expect(storeGone).toBe(true);
      const projectGone = yield* getProject({
        idOrName: fn.projectId,
        teamId,
      }).pipe(
        Effect.map(() => false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (g) => g,
          times: 10,
        }),
      );
      expect(projectGone).toBe(true);
    }).pipe(logLevel),
  { timeout: 240_000 },
);
