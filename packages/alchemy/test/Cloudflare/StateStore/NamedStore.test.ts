import * as Cloudflare from "@/Cloudflare";
import * as CloudflareEnvironment from "@/Cloudflare/CloudflareEnvironment.ts";
import {
  authTokenSecretName,
  encryptionKeySecretName,
} from "@/Cloudflare/StateStore/Names.ts";
import * as Test from "@/Test/Alchemy";
import * as SecretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

/**
 * Live coexistence coverage for named state stores (#912): a
 * `workerName`-selected store must have its own Worker, Durable Object
 * state, bearer-token secret, and encryption-key secret — and neither
 * the named store's bootstrap/teardown nor the default store's
 * bootstrap may touch the other.
 *
 * The tests are one sequence: bootstrap the named store, prove the
 * stores don't see each other's state, then tear the named store down
 * and prove the default store survived.
 */

const NAMED = "alchemy-state-store-e2e";
const STACK = "NamedStoreE2E";
const STAGE = "e2e";
const FQN = "NamedStoreE2E/scope/resource-a";

const { test } = Test.make({
  providers: Cloudflare.providers(),
});

const sampleState = {
  kind: "resource" as const,
  resourceType: "Test.Resource",
  namespace: undefined,
  fqn: FQN,
  logicalId: "resource-a",
  instanceId: "inst-a",
  providerVersion: 1,
  status: "created" as const,
  downstream: [],
  bindings: [],
  props: { hello: "named-store" },
  attr: { id: "inst-a" },
};

const accountId = Effect.gen(function* () {
  const { accountId } =
    yield* yield* CloudflareEnvironment.CloudflareEnvironment;
  return accountId;
});

const scriptExists = (scriptName: string) =>
  Effect.gen(function* () {
    const account = yield* accountId;
    return yield* workers
      .getScriptSetting({ accountId: account, scriptName })
      .pipe(
        Effect.map(() => true),
        Effect.catchTag(["WorkerNotFound", "InvalidRoute"], () =>
          Effect.succeed(false),
        ),
      );
  });

const listSecretNames = Effect.gen(function* () {
  const account = yield* accountId;
  const store = yield* SecretsStore.listStores
    .items({ accountId: account })
    .pipe(Stream.runHead, Effect.map(Option.getOrUndefined));
  if (!store) return [];
  return yield* SecretsStore.listStoreSecrets
    .items({ accountId: account, storeId: store.id })
    .pipe(
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk).map((s) => s.name)),
    );
});

describe.sequential("NamedStore", () => {
  test.provider.skipIf(!!process.env.FAST)(
    "bootstrap({ workerName }) deploys a dedicated store and serves state",
    () =>
      Effect.gen(function* () {
        const named = yield* Cloudflare.bootstrap({ workerName: NAMED });

        // The named store serves its own state roundtrip.
        yield* named.deleteStack({ stack: STACK });
        yield* named.set({
          stack: STACK,
          stage: STAGE,
          fqn: FQN,
          value: sampleState,
        });
        const got = yield* named.get({ stack: STACK, stage: STAGE, fqn: FQN });
        expect(got).toBeDefined();
        expect((got as any).props).toEqual({ hello: "named-store" });

        // Out-of-band: the named store is its own physical Worker, and its
        // secrets are per-store (suffixed) names in the account Secrets Store.
        expect(yield* scriptExists(NAMED)).toBe(true);
        const secretNames = yield* listSecretNames;
        expect(secretNames).toContain(authTokenSecretName(NAMED));
        expect(secretNames).toContain(encryptionKeySecretName(NAMED));
      }),
    { timeout: 420_000 },
  );

  test.provider.skipIf(!!process.env.FAST)(
    "the default store and the named store cannot see each other's state",
    () =>
      Effect.gen(function* () {
        // Attaching to the default store (bootstrap without a name adopts the
        // existing deployment) must not surface the named store's stack...
        const def = yield* Cloudflare.bootstrap({});
        const fqns = yield* def.list({ stack: STACK, stage: STAGE });
        expect(fqns).not.toContain(FQN);

        // ...and must not have redeployed or mutated the named store: its
        // Worker still exists and still serves the state written above.
        expect(yield* scriptExists(NAMED)).toBe(true);
        const named = yield* Cloudflare.bootstrap({ workerName: NAMED });
        const got = yield* named.get({ stack: STACK, stage: STAGE, fqn: FQN });
        expect(got).toBeDefined();
        expect((got as any).props).toEqual({ hello: "named-store" });
      }),
    { timeout: 300_000 },
  );

  test.provider.skipIf(!!process.env.FAST)(
    "teardown of the named store leaves the default store untouched",
    () =>
      Effect.gen(function* () {
        yield* Cloudflare.teardownStateStore({ workerName: NAMED });

        // The named store's Worker and secrets are gone...
        expect(yield* scriptExists(NAMED)).toBe(false);
        const secretNames = yield* listSecretNames;
        expect(secretNames).not.toContain(authTokenSecretName(NAMED));
        expect(secretNames).not.toContain(encryptionKeySecretName(NAMED));

        // ...while the default store's Worker and secrets survive.
        expect(yield* scriptExists("alchemy-state-store")).toBe(true);
        expect(secretNames).toContain("AlchemyStateStoreToken");
        expect(secretNames).toContain("AlchemyStateStoreEncryptionKey");
      }),
    { timeout: 180_000 },
  );
});
