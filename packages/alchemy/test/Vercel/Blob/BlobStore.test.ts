import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import {
  createProject,
  deleteProject,
  filterProjectEnvs,
  getProjectEnv,
} from "@distilled.cloud/vercel/projects";
import {
  getStorageStoreConnections,
  getStorageStores,
  getStorageStoresById,
} from "@distilled.cloud/vercel/storage";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

const { test } = Test.make({ providers: Vercel.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const BLOB_API = "https://blob.vercel-storage.com";

/**
 * Create a host project out-of-band (deterministic name), run `use`, and
 * always delete the project afterwards. A leftover from an interrupted run
 * is deleted up-front so the fixture is self-healing.
 */
const withHostProject = <A, E, R>(
  name: string,
  use: (projectId: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    yield* deleteProject({ idOrName: name, teamId }).pipe(
      Effect.catchTag("NotFound", () => Effect.void),
    );
    const project = yield* createProject({ name, teamId });
    return yield* use(project.id).pipe(
      Effect.ensuring(
        deleteProject({ idOrName: name, teamId }).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.ignore,
        ),
      ),
    );
  });

test.provider(
  "blob store lifecycle: create, connect, data plane, disconnect, destroy",
  (stack) =>
    Effect.gen(function* () {
      const { teamId } = yield* Vercel.VercelEnvironment.current;
      yield* stack.destroy();

      yield* withHostProject("alchemy-test-blobstore-host", (projectId) =>
        Effect.gen(function* () {
          const store = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Vercel.BlobStore("Store", {
                access: "private",
                region: "iad1",
                projects: [projectId],
              });
            }),
          );
          expect(store.storeId).toMatch(/^store_/);
          expect(store.access).toEqual("private");
          expect(store.region).toEqual("iad1");
          expect(store.projectIds).toEqual([projectId]);

          // out-of-band: the store and its connection exist
          const fetched = yield* getStorageStoresById({
            id: store.storeId,
            teamId,
          });
          expect(fetched.store.name).toEqual(store.name);
          expect(fetched.store.access).toEqual("private");
          const conns = yield* getStorageStoreConnections({
            storeId: store.storeId,
            teamId,
          });
          expect(conns.connections.map((c) => c.projectId)).toEqual([
            projectId,
          ]);

          // the connection injected the token env var into the project
          // (bounded retry: the injected var can lag the connect by a beat)
          const tokenEnv = yield* filterProjectEnvs({
            idOrName: projectId,
            teamId,
          }).pipe(
            Effect.map((envs) =>
              "envs" in envs
                ? envs.envs.find((env) => env.key === "BLOB_READ_WRITE_TOKEN")
                : undefined,
            ),
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (env) => env !== undefined,
              times: 8,
            }),
          );
          expect(tokenEnv).toBeDefined();

          // the decrypted token drives the Blob data plane (settles the
          // D6 token-acquisition path live)
          const decrypted = yield* getProjectEnv({
            idOrName: projectId,
            id: tokenEnv!.id!,
            teamId,
          });
          const token = "value" in decrypted ? decrypted.value : undefined;
          expect(token).toMatch(/^vercel_blob_rw_/);

          const headers = {
            authorization: `Bearer ${token}`,
            "x-api-version": "12",
            "x-vercel-blob-store-id": token!.split("_")[3] ?? "",
            "x-vercel-blob-access": "private",
          };
          const putUrl = `${BLOB_API}/?pathname=${encodeURIComponent("alchemy/probe.txt")}`;
          const putRes = yield* HttpClient.execute(
            HttpClientRequest.put(putUrl).pipe(
              HttpClientRequest.setHeaders({
                ...headers,
                "x-allow-overwrite": "1",
                "x-add-random-suffix": "0",
              }),
              HttpClientRequest.bodyText("hello from alchemy", "text/plain"),
            ),
          );
          expect(putRes.status).toBe(200);
          const putBody = (yield* putRes.json) as {
            url: string;
            pathname: string;
            etag?: string;
          };
          expect(putBody.pathname).toEqual("alchemy/probe.txt");

          // read-after-write on the private blob URL (authenticated)
          const getRes = yield* HttpClient.execute(
            HttpClientRequest.get(putBody.url).pipe(
              HttpClientRequest.setHeaders({
                authorization: `Bearer ${token}`,
              }),
            ),
          );
          expect(getRes.status).toBe(200);
          expect(yield* getRes.text).toEqual("hello from alchemy");

          // conditional write with a wrong etag is rejected (CAS)
          const casRes = yield* HttpClient.execute(
            HttpClientRequest.put(putUrl).pipe(
              HttpClientRequest.setHeaders({
                ...headers,
                "x-allow-overwrite": "1",
                "x-add-random-suffix": "0",
                "x-if-match": '"deadbeef"',
              }),
              HttpClientRequest.bodyText("cas write", "text/plain"),
            ),
          );
          expect(casRes.status).toBe(412);

          // conditional create: a second put without allowOverwrite fails
          const overwriteRes = yield* HttpClient.execute(
            HttpClientRequest.put(putUrl).pipe(
              HttpClientRequest.setHeaders({
                ...headers,
                "x-allow-overwrite": "0",
                "x-add-random-suffix": "0",
              }),
              HttpClientRequest.bodyText("second write", "text/plain"),
            ),
          );
          expect(overwriteRes.status).toBe(400);

          // clean up the blob so the store deletes empty
          const delRes = yield* HttpClient.execute(
            HttpClientRequest.post(`${BLOB_API}/delete`).pipe(
              HttpClientRequest.setHeaders(headers),
              HttpClientRequest.bodyJsonUnsafe({ urls: [putBody.url] }),
            ),
          );
          expect(delRes.status).toBe(200);

          // disconnect: drop the project from the desired list
          const updated = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Vercel.BlobStore("Store", {
                access: "private",
                region: "iad1",
                projects: [],
              });
            }),
          );
          expect(updated.storeId).toEqual(store.storeId);
          expect(updated.projectIds).toEqual([]);

          const connsAfter = yield* getStorageStoreConnections({
            storeId: store.storeId,
            teamId,
          });
          expect(connsAfter.connections).toEqual([]);
          const envsAfter = yield* filterProjectEnvs({
            idOrName: projectId,
            teamId,
          });
          const tokenEnvAfter =
            "envs" in envsAfter
              ? envsAfter.envs.find(
                  (env) => env.key === "BLOB_READ_WRITE_TOKEN",
                )
              : undefined;
          expect(tokenEnvAfter).toBeUndefined();

          // destroy and verify the store is gone (typed NotFound)
          yield* stack.destroy();
          const gone = yield* getStorageStoresById({
            id: store.storeId,
            teamId,
          }).pipe(
            Effect.map(() => false),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
          );
          expect(gone).toBe(true);
        }),
      );
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider("blob store is stable across a no-op update", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deploy = stack.deploy(
      Vercel.BlobStore("NoopStore", { access: "public", region: "iad1" }),
    );
    const created = yield* deploy;
    expect(created.storeId).toMatch(/^store_/);
    expect(created.access).toEqual("public");

    const updated = yield* deploy;
    expect(updated.storeId).toEqual(created.storeId);
    expect(updated.name).toEqual(created.name);

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider("changing access forces a replacement", (stack) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    yield* stack.destroy();

    const created = yield* stack.deploy(
      Vercel.BlobStore("ReplStore", { access: "public", region: "iad1" }),
    );
    expect(created.access).toEqual("public");

    const replaced = yield* stack.deploy(
      Vercel.BlobStore("ReplStore", { access: "private", region: "iad1" }),
    );
    expect(replaced.access).toEqual("private");
    expect(replaced.storeId).not.toEqual(created.storeId);

    yield* stack.destroy();
    const gone = yield* getStorageStoresById({
      id: replaced.storeId,
      teamId,
    }).pipe(
      Effect.map(() => false),
      Effect.catchTag("NotFound", () => Effect.succeed(true)),
    );
    expect(gone).toBe(true);
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed store", (stack) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Vercel.BlobStore("ListStore", { access: "public", region: "iad1" }),
    );

    const { stores } = yield* getStorageStores({ teamId });
    const found = stores.find((s) => s.id === deployed.storeId);
    expect(found).toBeDefined();
    expect(found!.type).toEqual("blob");

    yield* stack.destroy();
  }).pipe(logLevel),
);
