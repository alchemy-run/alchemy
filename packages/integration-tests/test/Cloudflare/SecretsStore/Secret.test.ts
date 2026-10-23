import * as Cloudflare from "@alchemy.run/cloudflare";
import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import { expect } from "alchemy-test";
import { adopt } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Canonical `list()` test (parent fan-out): secrets are sub-resources of a
// Secrets Store and there is no account-wide secret enumeration API, so
// `list()` enumerates every store and lists the secrets inside each. Deploy a
// store + secret, then assert the deployed secret appears in the result.
test.provider(
  "list enumerates the deployed secret across stores",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* Cloudflare.SecretsStore.Store("ListSecretStore");
          return yield* Cloudflare.SecretsStore.Secret("ListSecret", {
            store,
            value: Redacted.make("sk-list-test-value"),
          });
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.SecretsStore.Secret);
      const all = yield* provider.list();

      expect(all.some((s) => s.secretId === deployed.secretId)).toBe(true);
      const found = all.find((s) => s.secretId === deployed.secretId)!;
      expect(found.secretName).toEqual(deployed.secretName);
      expect(found.storeId).toEqual(deployed.storeId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:secretsstore", "live"] },
);

// A Secret with no state is found by name. The store's listing order is not
// stable across pages, so the lookup asks the API to search by name rather
// than scanning every page; seed more than one page (the API pages by 20) so
// the lookup runs against a paginated store.
test.provider(
  "adopts a secret by name from a store with more than one page of secrets",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const store = yield* stack.deploy(Cloudflare.SecretsStore.Store("PagedSecretStore"));
      const key = { accountId: store.accountId, storeId: store.storeId };
      const seeded = yield* secretsStore.createStoreSecret({
        ...key,
        body: [
          ...Array.from({ length: 21 }, (_, i) => ({
            name: `paged-secret-filler-${i}`,
            scopes: ["workers" as const],
            value: "filler",
          })),
          { name: "paged-secret-target", scopes: ["workers" as const], value: "sk-paged" },
        ],
      });
      const fillers = seeded.result.filter((s) => s.name !== "paged-secret-target");
      const target = seeded.result.find((s) => s.name === "paged-secret-target")!;

      yield* Effect.gen(function* () {
        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const store = yield* Cloudflare.SecretsStore.Store("PagedSecretStore");
            return yield* Cloudflare.SecretsStore.Secret("PagedSecret", {
              store,
              name: "paged-secret-target",
              value: Redacted.make("sk-paged"),
            }).pipe(adopt(true));
          }),
        );
        expect(deployed.secretId).toEqual(target.id);
      }).pipe(
        Effect.ensuring(
          Effect.forEach(
            fillers,
            (s) =>
              secretsStore
                .deleteStoreSecret({ ...key, secretId: s.id })
                .pipe(Effect.catchTag("SecretNotFound", () => Effect.void)),
            { concurrency: 5, discard: true },
          ).pipe(Effect.orDie),
        ),
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:secretsstore", "live"],
    timeout: 120_000,
  },
);

// #995: an interrupted first deploy can persist `creating` props whose parent
// Outputs were stripped to holes, so `olds.store` survives as `{}`. `read`
// must treat an unresolved parent reference like a missing one (return
// `undefined` → plan falls through to the create path) instead of handing
// `storeId: undefined` to the API and crashing every later plan with a
// SchemaError defect.
test.provider(
  "read treats an unresolved parent store reference as missing",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(Cloudflare.SecretsStore.Secret);
      const attr = yield* provider.read!({
        id: "OrphanSecret",
        fqn: "OrphanSecret",
        instanceId: "orphan-instance",
        olds: { store: {} as never, value: Redacted.make("sk-orphan") },
        output: undefined,
      });
      expect(attr).toBeUndefined();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:secretsstore", "live"] },
);
