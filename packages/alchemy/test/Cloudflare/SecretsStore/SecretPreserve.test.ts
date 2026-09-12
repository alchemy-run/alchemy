import { adopt } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  CONTROL_SECRET_NAME,
  PRESERVED_SECRET_NAME,
  PreserveStore,
  PROGRAM_VALUE,
} from "./fixtures/preserve-secret.ts";
import PreserveSecretWorker from "./fixtures/preserve-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/** The value that "was already there" before alchemy adopted the secret. */
const SEEDED_VALUE = "sk-seeded-before-alchemy";

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const readValue = (url: string) =>
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
          Schedule.exponential("500 millis"),
          Schedule.recurs(30),
        ]),
      }),
    );
    return ((yield* res.json) as { value: string }).value;
  });

/**
 * Drop any leftover fixture secrets from an earlier run, then seed both
 * names out-of-band with a value alchemy has never seen. Waits for the
 * seeded secrets to activate so the adopting deploy observes them.
 */
const seedSecrets = (store: { accountId: string; storeId: string }) =>
  Effect.gen(function* () {
    const names = new Set([PRESERVED_SECRET_NAME, CONTROL_SECRET_NAME]);
    const existing = yield* secretsStore.listStoreSecrets.items(store).pipe(
      Stream.filter((s) => names.has(s.name)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    );
    yield* Effect.forEach(existing, (s) =>
      secretsStore
        .deleteStoreSecret({ ...store, secretId: s.id })
        .pipe(Effect.catchTag("SecretNotFound", () => Effect.void)),
    );
    // Deletion is asynchronous on Cloudflare's side; a re-create races it.
    yield* secretsStore
      .createStoreSecret({
        ...store,
        body: [...names].map((name) => ({
          name,
          value: SEEDED_VALUE,
          scopes: ["workers"],
        })),
      })
      .pipe(
        Effect.retry({
          while: (e) => e._tag === "SecretNameAlreadyExists",
          schedule: Schedule.spaced("2 seconds"),
          times: 15,
        }),
      );
    yield* Effect.forEach([...names], (name) =>
      secretsStore.listStoreSecrets.items(store).pipe(
        Stream.filter((s) => s.name === name && s.status === "active"),
        Stream.runHead,
        Effect.repeat({
          until: (found) => found._tag === "Some",
          schedule: Schedule.spaced("1 second"),
          times: 30,
        }),
      ),
    );
  });

// The Cloudflare state store bootstrap adopts its encryption-key secret with
// `adopt(true)`; the default provider then PATCHes the adopted secret with the
// program's value — the beta.45 key-rotation mechanism. `preserveExistingValue`
// must keep the stored value in exactly that situation, while a plain secret
// keeps today's overwrite semantics.
test.provider(
  "preserveExistingValue keeps an adopted secret's stored value; a plain secret is overwritten",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const store = yield* stack.deploy(PreserveStore);
      yield* seedSecrets({
        accountId: store.accountId,
        storeId: store.storeId,
      });

      const worker = yield* Effect.gen(function* () {
        return yield* PreserveSecretWorker;
      }).pipe(adopt(true), stack.deploy);

      const url = worker.url as string;
      expect(yield* readValue(`${url}/preserved`)).toBe(SEEDED_VALUE);
      expect(yield* readValue(`${url}/control`)).toBe(PROGRAM_VALUE);

      // A second deploy (routine update path) leaves the preserved value alone.
      yield* Effect.gen(function* () {
        return yield* PreserveSecretWorker;
      }).pipe(stack.deploy);
      expect(yield* readValue(`${url}/preserved`)).toBe(SEEDED_VALUE);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);
