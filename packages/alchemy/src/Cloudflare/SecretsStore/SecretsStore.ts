import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AdoptPolicy } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

export type SecretsStore = Resource<
  "Cloudflare.SecretsStore",
  {},
  {
    storeId: string;
    storeName: string;
    accountId: string;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Secrets Store, a per-account container for secrets that
 * can be bound into Workers with full redaction and audit support.
 *
 * Cloudflare enforces a limit of **one Secrets Store per account**.
 * Deleting a store changes its ID and permanently destroys all secrets
 * inside it. Because of this, the provider always **adopts** an existing
 * store rather than creating a new one, and **never deletes** the store
 * on teardown. If no store exists yet, one is created, but once it
 * exists it is treated as account-level infrastructure that outlives
 * any single stack.
 *
 * @section Creating a Store
 * @example Basic Secrets Store (adopts existing or creates one)
 * ```typescript
 * const store = yield* Cloudflare.SecretsStore("MyStore");
 * ```
 *
 * @example Adopt a specific named store
 * ```typescript
 * const store = yield* Cloudflare.SecretsStore("MyStore", {
 *   name: "production-secrets",
 * });
 * ```
 */
export const SecretsStore = Resource<SecretsStore>("Cloudflare.SecretsStore");

export const SecretsStoreProvider = () =>
  Provider.effect(
    SecretsStore,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const createStore = yield* secretsStore.createStore;
      const listStores = yield* secretsStore.listStores;

      return {
        stables: ["storeId", "storeName", "accountId"],
        create: Effect.fn(function* () {
          const adoptEnabled = yield* Effect.serviceOption(AdoptPolicy).pipe(
            Effect.map(Option.getOrElse(() => true)),
          );

          const adoptExisting = Effect.gen(function* () {
            const stores = yield* listStores({ accountId });
            const first = stores.result[0];
            if (!first) return undefined;
            return {
              storeId: first.id,
              storeName: first.name,
              accountId,
            };
          });

          // Cloudflare allows exactly one Secrets Store per account, so
          // any account that's been touched before may already have one.
          // Only adopt it if the caller opted in via `AdoptPolicy`,
          // otherwise let `createStore` surface MaximumStoresExceeded.
          if (adoptEnabled) {
            const adopted = yield* adoptExisting;
            if (adopted) return adopted;
          }

          const create = createStore({
            accountId,
            // `default_secrets_store` is the name Cloudflare uses for an
            // account's default Secrets Store.
            name: "default_secrets_store",
          });
          const response = adoptEnabled
            ? yield* create.pipe(
                // A concurrent process (or a previous partially-failed
                // deploy) may have raced us between list and create.
                Effect.catchTag("MaximumStoresExceeded", () =>
                  Effect.succeed(undefined),
                ),
              )
            : yield* create;

          if (response) {
            return {
              storeId: response.id,
              storeName: response.name,
              accountId,
            };
          }

          const recovered = yield* adoptExisting;
          if (recovered) return recovered;

          return yield* Effect.die(
            new Error(
              `Cloudflare reported MaximumStoresExceeded for account ${accountId} but no store could be listed.`,
            ),
          );
        }),
        update: Effect.fn(function* ({ output }) {
          return output;
        }),
        delete: Effect.fn(function* () {
          // Intentional no-op. Cloudflare only allows one Secrets Store per
          // account and deleting it permanently destroys all secrets inside.
          // The store is treated as shared, account-level infrastructure that
          // should never be torn down by a single stack.
        }),
        read: Effect.fn(function* ({ output }) {
          if (!output?.storeId) return undefined;
          const stores = yield* listStores({
            accountId: output.accountId,
          });
          const match = stores.result.find((s) => s.id === output.storeId);
          if (!match) return undefined;
          return {
            storeId: match.id,
            storeName: match.name,
            accountId: output.accountId,
          };
        }),
      };
    }),
  );
