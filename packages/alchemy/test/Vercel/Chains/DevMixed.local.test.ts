/**
 * DEPTH chain 9 — dev-mode mixed stack: a LOCAL `Vercel.Function` binding a
 * LIVE `Vercel.BlobStore` (`Alchemy.remote()`), then the provider-mode FLIP
 * of the Function itself, cycled both directions.
 *
 * Runs under `Test.make({ dev: true })` (RPC sidecar topology, same as the
 * real `alchemy dev`). Four full deploy cycles over one stack:
 *
 *   1. **Mixed deploy** — local fn (`dev:` markers) + live store (real
 *      `store_` id) + a mode-agnostic donor `Vercel.Project` connected via
 *      the store's `projects` prop. The fn's binding contributes its `dev:`
 *      project id, which the store reconciler must FILTER (never handed to
 *      the connections API); without a token the fn's blob client reports
 *      the documented missing-token contract.
 *   2. **Hot restart** — env change (greeting + the donor-harvested real
 *      `BLOB_READ_WRITE_TOKEN`) restarts the local instance: URL and
 *      `dev:` project id STABLE, deploymentId CHANGED, and the local fn now
 *      round-trips against the REAL data plane (out-of-band verified from
 *      the test process with the same token).
 *   3. **Mode flip → remote** — `Alchemy.remote()` on the fn: the plan
 *      classifies a REPLACEMENT (ProviderMode doctrine), the deploy yields a
 *      real project/deployment, the old local instance is deleted (its port
 *      stops serving — stamped-local delete routed through the sidecar), the
 *      store gains the real project connection (platform token injection),
 *      and the blob written by the LOCAL fn in cycle 2 is served by the LIVE
 *      fn — the store is the stable data spine across the flip.
 *   4. **Flip back → local** — replacement again: `dev:` identity returns,
 *      the live project is deleted from the cloud (stamped-live delete in a
 *      dev run), the store's connection set shrinks back to the donor, and
 *      both cycle-2 and cycle-3 blobs remain readable through the local fn.
 *
 * Destroy at start and end; census: store + donor project gone from the
 * cloud, no local instance still serving.
 */
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import * as Vercel from "@/Vercel";
import {
  filterProjectEnvs,
  getProject,
  getProjectEnv,
} from "@distilled.cloud/vercel/projects";
import {
  getStorageStoreConnections,
  getStorageStoresById,
} from "@distilled.cloud/vercel/storage";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";

const { test } = Test.make({
  providers: Vercel.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureMain = new URL("./fixtures/mixed-blob-fn.ts", import.meta.url)
  .pathname;

const BLOB_TOKEN_ENV = "BLOB_READ_WRITE_TOKEN";

class NotReady extends Data.TaggedError("NotReady")<{
  status: number;
  message: string;
}> {}

// First requests race the dev bundle's first build (local) or fresh
// .vercel.app URL propagation (live) — bounded retry either way.
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
                message: `GET ${url} -> ${res.status}`,
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

/** Status of a GET, or -1 when the transport itself fails (dead port). */
const statusOf = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.map((res) => res.status),
      Effect.catch(() => Effect.succeed(-1)),
    );
  });

/**
 * Harvest the platform-injected `BLOB_READ_WRITE_TOKEN` from a connected
 * project via the single-env GET (the injected row is `encrypted`; the
 * single-env GET returns plaintext — PROBES.md D6). Bounded retry:
 * injection can lag the connect call.
 */
const harvestBlobToken = (projectId: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* Vercel.VercelEnvironment.current;
    const envsBody = yield* filterProjectEnvs({ idOrName: projectId, teamId });
    const rows = (
      Array.isArray(envsBody)
        ? envsBody
        : typeof envsBody === "object" &&
            envsBody !== null &&
            "envs" in envsBody
          ? (envsBody as { envs: unknown[] }).envs
          : []
    ) as Array<{ key?: string; id?: string }>;
    const tokenRow = rows.find((row) => row.key === BLOB_TOKEN_ENV);
    if (tokenRow?.id === undefined) return undefined;
    const decrypted = yield* getProjectEnv({
      idOrName: projectId,
      id: tokenRow.id,
      teamId,
    });
    return typeof decrypted === "object" &&
      decrypted !== null &&
      "value" in decrypted &&
      typeof decrypted.value === "string" &&
      decrypted.value !== ""
      ? decrypted.value
      : undefined;
  }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (token) => token !== undefined,
      times: 15,
    }),
    Effect.flatMap((token) =>
      token === undefined
        ? Effect.die(
            `${BLOB_TOKEN_ENV} was never injected into the donor project`,
          )
        : Effect.succeed(token),
    ),
  );

/** Poll (bounded) until the project is gone from the cloud. */
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

/** Poll (bounded) until the blob store is gone from the cloud. */
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

/**
 * Best-effort purge of every blob in the chain store via the harvested
 * data-plane token — crash-safety: `Effect.ensuring` this behind the
 * cycles so a mid-test failure can never strand a non-empty store (whose
 * delete would 409 `not_empty` forever; the delete's disconnect phase
 * would ALSO revoke the only token, wedging cleanup — observed live).
 */
const purgeChainBlobs = (token: string) =>
  Effect.tryPromise(async () => {
    const client = Vercel.readWriteBlobFromEnv({ token, access: "public" });
    const listed = await client.list();
    if (listed.blobs.length > 0) {
      await client.del(listed.blobs.map((blob) => blob.pathname));
    }
  }).pipe(Effect.ignore);

/** Engine-level plan action for a logical id. */
const actionOf = (plan: any, logicalId: string) =>
  (Object.values(plan.resources) as any[]).find(
    (node: any) => node.resource.LogicalId === logicalId,
  )?.action;

interface CycleOptions {
  greeting: string;
  remote: boolean;
  token?: string | undefined;
}

/**
 * The chain's one program, re-deployed each cycle with different options.
 * The store is ALWAYS live (`Alchemy.remote()`); only the Function's mode
 * flips. The store↔fn edge is circular on purpose (fn env captures
 * `store.storeId`; the store's binding contract receives `fn.projectId`) —
 * the Function's precreate stub breaks the cycle, exactly like the live
 * capability suite.
 */
const program = (opts: CycleOptions) =>
  Effect.gen(function* () {
    const donor = yield* Vercel.Project("TokenDonor", {});
    const store = yield* Vercel.BlobStore("MixedStore", {
      access: "public",
      projects: [donor.projectId],
    }).pipe(Alchemy.remote());
    const fn = yield* Vercel.Function("MixedFn", {
      main: fixtureMain,
      env: {
        GREETING: opts.greeting,
        BLOB_STORE_ID: store.storeId,
        ...(opts.token !== undefined ? { [BLOB_TOKEN_ENV]: opts.token } : {}),
      },
    }).pipe(Alchemy.remote(opts.remote));
    yield* store.bind("MixedFn", { projects: [fn.projectId] });
    return { donor, store, fn };
  });

test.provider(
  "dev-mixed chain: local fn + live store, hot restart, mode flips both ways, stamped deletes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { teamId } = yield* Vercel.VercelEnvironment.current;

      // ── Cycle 1: mixed deploy — local fn, live store, donor project.
      const c1 = yield* stack.deploy(
        program({ greeting: "hello", remote: false }),
      );

      // dev identity markers on the fn — proof its lifecycle never left the
      // local provider.
      expect(c1.fn.url).toMatch(/^http:\/\/localhost:\d+$/);
      expect(c1.fn.projectId).toMatch(/^dev:/);
      expect(c1.fn.deploymentId).toMatch(/^dev:/);

      // The store is REAL (remote() in a dev run) and the donor is real too
      // (Project is mode-agnostic → always live).
      expect(c1.store.storeId).toMatch(/^store_/);
      expect(c1.store.localApiUrl).toBeUndefined();
      expect(c1.donor.projectId).toMatch(/^prj_/);

      // The fn's binding contributed its dev: project id — the store
      // reconciler must FILTER it: only the donor is connected, both in the
      // returned attributes and out-of-band on the cloud API.
      expect(c1.store.projectIds).toEqual([c1.donor.projectId]);
      const connections1 = yield* getStorageStoreConnections({
        storeId: c1.store.storeId,
        teamId,
      });
      expect(connections1.connections.map((c) => c.projectId).sort()).toEqual([
        c1.donor.projectId,
      ]);
      const found = yield* getStorageStoresById({
        id: c1.store.storeId,
        teamId,
      });
      expect(found.store.id).toBe(c1.store.storeId);

      // Local runtime env: platform dev env + the store id capture, but NO
      // token (a live store's token only exists as project env of a real
      // connected project — the documented mixed-stack contract).
      const env1 = (yield* getJsonReady(`${c1.fn.url}/env`)) as {
        greeting: string | null;
        vercelEnv: string | null;
        storeId: string | null;
        hasToken: boolean;
      };
      expect(env1.greeting).toBe("hello");
      expect(env1.vercelEnv).toBe("development");
      expect(env1.storeId).toBe(c1.store.storeId);
      expect(env1.hasToken).toBe(false);
      const putNoToken = (yield* getJsonReady(
        `${c1.fn.url}/blob/put?path=chain%2Fmsg.txt&body=x`,
      )) as { tokenMissing?: boolean };
      expect(putNoToken.tokenMissing).toBe(true);

      // Harvest the donor's platform-injected token — the supported route
      // to a live data plane from a local process.
      const token = yield* harvestBlobToken(c1.donor.projectId);
      expect(token).toMatch(/^vercel_blob_rw_/);

      // From here on, blobs exist in the live store — ensure they are
      // purged even if a cycle fails, so teardown's store delete cannot
      // 409 `not_empty` (see purgeChainBlobs).
      yield* Effect.gen(function* () {
        // ── Cycle 2: env change → hot restart. URL + dev project STABLE,
        // deploymentId CHANGED, and the local fn now reaches the REAL data
        // plane with the injected token.
        const c2 = yield* stack.deploy(
          program({ greeting: "bonjour", remote: false, token }),
        );
        expect(c2.fn.url).toBe(c1.fn.url);
        expect(c2.fn.projectId).toBe(c1.fn.projectId);
        expect(c2.fn.deploymentId).not.toBe(c1.fn.deploymentId);
        expect(c2.store.storeId).toBe(c1.store.storeId);
        expect(c2.store.projectIds).toEqual([c1.donor.projectId]);

        // Make-before-break: poll until the restarted child serves the new
        // env.
        const env2 = yield* Effect.gen(function* () {
          return (yield* getJsonReady(`${c2.fn.url}/env`)) as {
            greeting: string | null;
            hasToken: boolean;
          };
        }).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("500 millis"),
            until: (env) => env.greeting === "bonjour",
            times: 60,
          }),
        );
        expect(env2.greeting).toBe("bonjour");
        expect(env2.hasToken).toBe(true);

        // LOCAL fn → REAL data plane round trip.
        const put2 = (yield* getJsonReady(
          `${c2.fn.url}/blob/put?path=chain%2Fmsg.txt&body=via-local`,
        )) as { etag: string; url: string; pathname: string };
        expect(put2.pathname).toBe("chain/msg.txt");
        expect(put2.url).toContain(".public.blob.vercel-storage.com");
        const got2 = (yield* getJsonReady(
          `${c2.fn.url}/blob/get?path=chain%2Fmsg.txt`,
        )) as { text: string };
        expect(got2.text).toBe("via-local");

        // Out-of-band from the TEST process with the same harvested token:
        // the write really landed in the live store.
        const outOfBand = Vercel.readWriteBlobFromEnv({
          token,
          access: "public",
        });
        const oob = yield* Effect.promise(() => outOfBand.get("chain/msg.txt"));
        expect(oob.text).toBe("via-local");

        // ── Cycle 3: mode flip → remote. The stamped-mode switch must plan a
        // REPLACEMENT (ProviderMode doctrine) — never an in-place update.
        const plan3 = yield* stack.plan(
          program({ greeting: "bonjour", remote: true }),
        );
        expect(actionOf(plan3, "MixedFn")).toBe("replace");
        expect(actionOf(plan3, "TokenDonor")).toBe("noop");

        const c3 = yield* stack.deploy(
          program({ greeting: "bonjour", remote: true }),
        );

        // CHANGED: real cloud identity.
        expect(c3.fn.projectId).toMatch(/^prj_/);
        expect(c3.fn.url).toMatch(/^https:\/\//);
        // STABLE: the store and donor survived the fn replacement untouched.
        expect(c3.store.storeId).toBe(c1.store.storeId);
        expect(c3.donor.projectId).toBe(c1.donor.projectId);

        // The binding now contributes a REAL project id → the store gained
        // the connection (donor + fn), and the platform injected the token
        // into the fn's project.
        expect(c3.store.projectIds).toEqual(
          [c1.donor.projectId, c3.fn.projectId].sort(),
        );
        const fnEnvs = yield* filterProjectEnvs({
          idOrName: c3.fn.projectId,
          teamId,
        });
        const fnEnvRows = (
          Array.isArray(fnEnvs)
            ? fnEnvs
            : typeof fnEnvs === "object" && fnEnvs !== null && "envs" in fnEnvs
              ? (fnEnvs as { envs: unknown[] }).envs
              : []
        ) as Array<{ key?: string }>;
        expect(
          fnEnvRows.find((row) => row.key === BLOB_TOKEN_ENV),
        ).toBeDefined();

        // The old LOCAL instance is GONE — the replacement's old-generation
        // delete routed to the stamped-local provider through the sidecar and
        // its port stopped serving.
        const deadLocal = yield* statusOf(`${c1.fn.url}/env`).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (status) => status !== 200,
            times: 10,
          }),
        );
        expect(deadLocal).not.toBe(200);

        // LIVE fn round trip: platform-injected token (no explicit env), and
        // the blob written by the LOCAL fn in cycle 2 is served — the store
        // is the stable data spine across the mode flip.
        const env3 = (yield* getJsonReady(`${c3.fn.url}/env`)) as {
          greeting: string | null;
          vercelEnv: string | null;
          hasToken: boolean;
        };
        expect(env3.greeting).toBe("bonjour");
        expect(env3.vercelEnv).toBe("production");
        expect(env3.hasToken).toBe(true);
        const got3 = (yield* getJsonReady(
          `${c3.fn.url}/blob/get?path=chain%2Fmsg.txt`,
        )) as { text: string };
        expect(got3.text).toBe("via-local");
        const put3 = (yield* getJsonReady(
          `${c3.fn.url}/blob/put?path=chain%2Flive.txt&body=via-live`,
        )) as { etag: string };
        expect(put3.etag).toBeDefined();

        // ── Cycle 4: flip back → local. Replacement again; dev: identity
        // returns; the live project is deleted from the CLOUD even though the
        // run is dev (stamped-live delete routing); the store's connections
        // shrink back to the donor.
        const plan4 = yield* stack.plan(
          program({ greeting: "bonjour", remote: false, token }),
        );
        expect(actionOf(plan4, "MixedFn")).toBe("replace");

        const c4 = yield* stack.deploy(
          program({ greeting: "bonjour", remote: false, token }),
        );
        expect(c4.fn.url).toMatch(/^http:\/\/localhost:\d+$/);
        expect(c4.fn.projectId).toMatch(/^dev:/);
        expect(c4.store.storeId).toBe(c1.store.storeId);
        expect(c4.store.projectIds).toEqual([c1.donor.projectId]);
        yield* expectProjectGone(c3.fn.projectId);

        // Both blobs (cycle-2 local write, cycle-3 live write) survive into
        // the fourth cycle through the local fn.
        const got4 = (yield* getJsonReady(
          `${c4.fn.url}/blob/get?path=chain%2Fmsg.txt`,
        )) as { text: string };
        expect(got4.text).toBe("via-local");
        const got4live = (yield* getJsonReady(
          `${c4.fn.url}/blob/get?path=chain%2Flive.txt`,
        )) as { text: string };
        expect(got4live.text).toBe("via-live");

        // Empty the store through the local fn so the destroy's store delete
        // cannot 409 `not_empty`.
        for (const path of ["chain%2Fmsg.txt", "chain%2Flive.txt"]) {
          const del = (yield* getJsonReady(
            `${c4.fn.url}/blob/del?path=${path}`,
          )) as { ok: boolean };
          expect(del.ok).toBe(true);
        }

        // ── Destroy + census: store and donor gone from the cloud, and no
        // local instance still serving.
        yield* stack.destroy();
        yield* expectStoreGone(c1.store.storeId);
        yield* expectProjectGone(c1.donor.projectId);
        const deadAfterDestroy = yield* statusOf(`${c4.fn.url}/env`).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (status) => status !== 200,
            times: 10,
          }),
        );
        expect(deadAfterDestroy).not.toBe(200);
      }).pipe(Effect.ensuring(purgeChainBlobs(token)));
    }).pipe(logLevel),
  // Four full cycles, two of which create/delete a REAL Vercel deployment —
  // justified per the chain doctrine.
  { timeout: 300_000 },
);
