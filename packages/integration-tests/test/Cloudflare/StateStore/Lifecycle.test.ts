import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { bootstrap, teardownStateStore } from "@alchemy.run/cloudflare/StateStore/State";
import {
  AuthTokenSecretName,
  EncryptionKeySecretName,
  stateStoreSecretName,
} from "@alchemy.run/cloudflare/StateStore/Token";
import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "alchemy-test";
import * as Alchemist from "alchemy/Alchemist";
import { State } from "alchemy/State/State";
import * as Test from "alchemy/Test/Alchemy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

/** Run with `CI` and the given env set, as a CI deploy would. */
const inCI = <A, E, R>(env: Readonly<Record<string, string>>, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const vars = { CI: "true", ...env };
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
      Object.assign(process.env, vars);
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }),
  );

const scriptExists = (accountId: string, scriptName: string) =>
  workers.getScriptSetting({ accountId, scriptName }).pipe(
    Effect.as(true),
    Effect.catchTag(["WorkerNotFound", "InvalidRoute", "WorkerHasNoVersions"], () =>
      Effect.succeed(false),
    ),
  );

test.provider(
  "a named Cloudflare state store bootstraps, serves state and tears down beside the default",
  () =>
    Effect.gen(function* () {
      const environment = yield* yield* CloudflareEnvironment;
      const { accountId } = environment;
      // Never the default store, which every other run on the account uses.
      const name = "lifecycle";
      const worker = "alchemy-state-store-lifecycle";
      const target = { _tag: "Provider", backend: "cloudflare", name } as const;
      const alchemist = Alchemist.layer();
      const defaultStacks = () =>
        Effect.flatMap(
          Alchemist.State.store({ _tag: "Provider", backend: "cloudflare" }).pipe(
            Effect.provide(alchemist),
          ),
          (store) => store.listStacks(),
        );

      const before = yield* defaultStacks();
      yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));

      const created = yield* Alchemist.State.bootstrap(target).pipe(Effect.provide(alchemist));
      expect(created.status).toBe("created");
      expect(yield* scriptExists(accountId, worker)).toBe(true);

      const adopted = yield* Alchemist.State.bootstrap(target).pipe(Effect.provide(alchemist));
      expect(adopted.status).toBe("adopted");

      // The store is deployed without a stack, so a new one holds no state.
      const store = yield* Alchemist.State.store(target).pipe(Effect.provide(alchemist));
      expect(yield* store.listStacks()).toEqual([]);

      const torn = yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));
      expect(torn.deleted).toEqual([worker]);
      expect(yield* scriptExists(accountId, worker)).toBe(false);

      // In CI, a missing store fails instead of being deployed on first use.
      // CI reads Cloudflare credentials from the environment only. The
      // deleted Worker's workers.dev URL can keep serving for a few seconds,
      // so retry until the edge reports it gone.
      expect(environment.type).toBe("apiToken");
      const expected = `Run 'alchemy state bootstrap --backend cloudflare --name ${name}`;
      const inCi = yield* inCI(
        environment.type === "apiToken"
          ? {
              CLOUDFLARE_API_TOKEN: Redacted.value(environment.apiToken),
              CLOUDFLARE_ACCOUNT_ID: accountId,
            }
          : {},
        Effect.exit(
          Alchemist.State.store(target).pipe(
            Effect.flatMap((store) => store.listStacks()),
            Effect.provide(alchemist),
          ),
        ),
      ).pipe(
        Effect.repeat({
          until: (exit) => Exit.isFailure(exit) && Cause.pretty(exit.cause).includes(expected),
          schedule: Schedule.spaced("5 seconds"),
          times: 12,
        }),
      );
      expect(Exit.isFailure(inCi)).toBe(true);
      if (Exit.isFailure(inCi)) expect(Cause.pretty(inCi.cause)).toContain(expected);
      expect(yield* scriptExists(accountId, worker)).toBe(false);

      // The default store kept serving through all of it.
      expect(yield* scriptExists(accountId, "alchemy-state-store")).toBe(true);
      expect(yield* defaultStacks()).toEqual(before);
    }),
  // Exclusive: sets `CI` on the process.
  {
    tags: ["provider:cloudflare", "provider:cloudflare:statestore", "live"],
    timeout: 300_000,
    exclusive: true,
  },
);

/** The ids of a store's two secrets, observed out-of-band. */
const secretIds = (accountId: string, workerName: string) =>
  Effect.gen(function* () {
    const names = [
      stateStoreSecretName(AuthTokenSecretName, workerName),
      stateStoreSecretName(EncryptionKeySecretName, workerName),
    ];
    const store = yield* secretsStore.listStores.items({ accountId }).pipe(Stream.runHead);
    if (store._tag === "None") return [];
    const secrets = yield* secretsStore.listStoreSecrets
      .items({ accountId, storeId: store.value.id })
      .pipe(Stream.runCollect);
    return names.map((name) => Array.from(secrets).find((secret) => secret.name === name)?.id);
  });

test.provider(
  "a state store pinned to an account and named by workerName deploys there and keeps its secrets",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const workerName = `alchemy-state-store-pin-${Test.defaultStage().replaceAll("_", "-")}`;
      const record = {
        kind: "resource" as const,
        resourceType: "Test.Resource",
        namespace: undefined,
        fqn: "pinned/a",
        logicalId: "a",
        instanceId: "kept",
        providerVersion: 1,
        status: "created" as const,
        downstream: [],
        bindings: [],
        props: { hello: "world" },
        attr: { id: "kept" },
      };
      yield* teardownStateStore({ workerName, accountId });

      // An account the credentials can't reach fails instead of falling back
      // to the profile's account.
      const unreachable = yield* Effect.exit(
        State.pipe(
          Effect.flatten,
          Effect.provide(Cloudflare.state({ workerName, accountId: "0".repeat(32) })),
        ),
      );
      expect(Exit.isFailure(unreachable)).toBe(true);
      if (Exit.isFailure(unreachable)) {
        expect(Cause.pretty(unreachable.cause)).toContain(`pinned to account ${"0".repeat(32)}`);
      }
      expect(yield* scriptExists(accountId, workerName)).toBe(false);

      // The pinned account deploys the Worker under exactly `workerName`.
      const state = yield* State.pipe(
        Effect.flatten,
        Effect.provide(Cloudflare.state({ workerName, accountId })),
      );
      yield* state.set({ stack: "pinned", stage: "test", fqn: "pinned/a", value: record });
      expect(yield* scriptExists(accountId, workerName)).toBe(true);
      const secrets = yield* secretIds(accountId, workerName);
      expect(secrets.every((id) => id !== undefined)).toBe(true);

      // A forced redeploy reuses both secrets, so state written before it
      // still decrypts.
      const redeployed = yield* bootstrap({ workerName, accountId, force: true });
      expect(yield* secretIds(accountId, workerName)).toEqual(secrets);
      expect(yield* redeployed.get({ stack: "pinned", stage: "test", fqn: "pinned/a" })).toEqual(
        record,
      );

      yield* teardownStateStore({ workerName, accountId });
      expect(yield* scriptExists(accountId, workerName)).toBe(false);
    }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:statestore", "live"],
    timeout: 300_000,
  },
);
