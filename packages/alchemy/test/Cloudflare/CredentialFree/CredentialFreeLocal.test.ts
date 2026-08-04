import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";
import { configFilePath } from "@/Auth/Profile.ts";

/**
 * Credential-free `alchemy dev`: an all-local stack must deploy, serve, and
 * tear down with ZERO Cloudflare credential resolutions.
 *
 * The suite pins the real mechanism, through the real `alchemy dev` process
 * topology (RPC sidecar): it runs under a profile name that has NO stored
 * configuration (asserted below). In this state:
 *
 * - the non-forcing `currentAccountId` probe sees no stored Cloudflare
 *   config and returns `undefined` WITHOUT attempting resolution, so local
 *   attributes are stamped `accountId: undefined`;
 * - any code path that still *forces* `CloudflareEnvironment` hits
 *   `loadOrConfigure`, which fails (`AuthError`, non-interactive, no
 *   prompt) and crashes the deploy — every forced resolution is loud.
 *
 * This is exactly the state of a fresh machine that has never run
 * `alchemy login`.
 */
const CREDENTIAL_FREE_PROFILE = "alchemy-test-credential-free";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
  profile: CREDENTIAL_FREE_PROFILE,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const getJsonReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

/**
 * Guard-rail: the test profile must actually be unconfigured, or the suite
 * would silently test the credentialed path. If this fails, delete the
 * profile from `~/.alchemy/profiles.json`.
 */
const assertProfileUnconfigured = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs
    .readFileString(configFilePath)
    .pipe(Effect.orElseSucceed(() => "{}"));
  const parsed = yield* Effect.try({
    try: () => JSON.parse(raw) as { profiles?: Record<string, unknown> },
    catch: () => ({}) as { profiles?: Record<string, unknown> },
  }).pipe(
    Effect.orElseSucceed(() => ({}) as { profiles?: Record<string, unknown> }),
  );
  expect(parsed.profiles?.[CREDENTIAL_FREE_PROFILE]).toBeUndefined();
});

test.provider(
  "all-local stack deploys, serves, and destroys with zero credential resolutions",
  (stack) =>
    Effect.gen(function* () {
      yield* assertProfileUnconfigured;
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const kv = yield* Cloudflare.KV.Namespace("CredFreeKV");
          const bucket = yield* Cloudflare.R2.Bucket("CredFreeBucket");
          const db = yield* Cloudflare.D1.Database("CredFreeDB");
          const queue = yield* Cloudflare.Queues.Queue("CredFreeQueue");
          const store = yield* Cloudflare.SecretsStore.Store("CredFreeStore");
          const secret = yield* Cloudflare.SecretsStore.Secret(
            "CredFreeSecret",
            {
              store,
              value: Redacted.make("sk-credential-free"),
            },
          );
          const worker = yield* Cloudflare.Worker("cred-free-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/credential-free-worker.ts",
            ),
            env: {
              KV: kv,
              BUCKET: bucket,
              DB: db,
              QUEUE: queue,
              SECRET: secret,
            },
          });
          const consumer = yield* Cloudflare.Queues.Consumer(
            "CredFreeConsumer",
            {
              queueId: queue.queueId,
              scriptName: worker.workerName,
            },
          );
          return { kv, bucket, db, queue, store, secret, worker, consumer };
        }),
      );

      // Every local resource fabricated a `dev:` identity — proof no cloud
      // call ran — and no accountId was stamped: the non-forcing probe
      // returned `undefined` (a forced resolution would have failed the
      // deploy with an AuthError).
      expect(deployed.kv.namespaceId).toMatch(/^dev:/);
      expect(deployed.bucket.bucketName).toMatch(/^dev:/);
      expect(deployed.db.databaseId).toMatch(/^dev:/);
      expect(deployed.queue.queueId).toMatch(/^dev:/);
      expect(deployed.store.storeId).toMatch(/^dev:/);
      expect(deployed.secret.secretId).toMatch(/^dev:/);
      expect(deployed.consumer.consumerId).toMatch(/^dev:/);
      expect(deployed.worker.url).toMatch(/^http:\/\/localhost:\d+$/);
      expect(deployed.kv.accountId).toBeUndefined();
      expect(deployed.bucket.accountId).toBeUndefined();
      expect(deployed.db.accountId).toBeUndefined();
      expect(deployed.queue.accountId).toBeUndefined();
      expect(deployed.store.accountId).toBeUndefined();
      expect(deployed.secret.accountId).toBeUndefined();
      expect(deployed.consumer.accountId).toBeUndefined();
      expect(deployed.worker.accountId).toBeUndefined();

      // Full local data plane over the worker's native bindings.
      const kvBody = (yield* getJsonReady(`${deployed.worker.url}/kv`)) as {
        value: string | null;
      };
      expect(kvBody.value).toBe("hello-kv");

      const r2Body = (yield* getJsonReady(`${deployed.worker.url}/r2`)) as {
        text: string | null;
      };
      expect(r2Body.text).toBe("hello-r2");

      const d1Body = (yield* getJsonReady(`${deployed.worker.url}/d1`)) as {
        names: string[];
      };
      expect(d1Body.names).toEqual(["alice"]);

      const secretBody = (yield* getJsonReady(
        `${deployed.worker.url}/secret`,
      )) as { value: string };
      expect(secretBody.value).toBe("sk-credential-free");

      const sent = (yield* getJsonReady(
        `${deployed.worker.url}/queue/send?text=cred-free`,
      )) as { sent: string };
      expect(sent.sent).toBe("cred-free");
      const received = yield* getJsonReady(
        `${deployed.worker.url}/queue/received`,
      ).pipe(
        Effect.map((body) => (body as { received: string[] }).received),
        Effect.repeat({
          schedule: Schedule.spaced("500 millis"),
          until: (received) => received.includes("cred-free"),
          times: 30,
        }),
      );
      expect(received).toContain("cred-free");

      // Teardown must also be credential-free.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
