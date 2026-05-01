import {
  Credentials,
  formatHeaders,
} from "@distilled.cloud/cloudflare/Credentials";
import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
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
      const createStore = yield* makeCreateStore;
      const listStores = yield* secretsStore.listStores;

      return {
        stables: ["storeId", "storeName", "accountId"],
        create: Effect.fn(function* () {
          const adoptEnabled = yield* Effect.serviceOption(AdoptPolicy).pipe(
            Effect.map(Option.getOrElse(() => false)),
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
            //`default_secrets_store` is the name cloudflare uses to create a secret store
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
              storeId: response.result.id,
              storeName: response.result.name,
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

/**
 * Direct HTTP `POST /accounts/{account_id}/secrets_store/stores` call.
 *
 * Cloudflare's REST API expects a single `{ "name": "..." }` JSON object
 * for this endpoint and rejects an array body with `invalid_json_body`
 * (code `1001`). The auto-generated `@distilled.cloud/cloudflare`
 * `createStore` operation incorrectly models the body as an array of
 * objects, so any call through it fails on accounts that don't already
 * have a Secrets Store. This helper bypasses the SDK and posts the
 * correct shape directly. The returned response shape matches the
 * actual API: `result` is a single store object (not an array).
 *
 * Surfaces `MaximumStoresExceeded` as a tagged error so the caller can
 * `Effect.catchTag` the same as if it had used the SDK's typed error.
 */
export const makeCreateStore = Effect.gen(function* () {
  const credentialsService = yield* Credentials;
  const client = yield* HttpClient.HttpClient;
  return (input: { accountId: string; name: string }) =>
    Effect.gen(function* () {
      const credentials = yield* credentialsService;
      const headers = formatHeaders(credentials);
      const url = `${credentials.apiBaseUrl}/accounts/${encodeURIComponent(input.accountId)}/secrets_store/stores`;
      const request = HttpClientRequest.post(url).pipe(
        HttpClientRequest.setHeaders(headers),
        HttpClientRequest.setHeader("Accept", "application/json"),
        HttpClientRequest.bodyJsonUnsafe({ name: input.name }),
      );
      const response = yield* client.execute(request).pipe(Effect.scoped);
      const body = yield* HttpClientResponse.schemaBodyJson(
        CreateStoreEnvelope,
      )(response);

      if (response.status >= 400 || body.success === false) {
        const first = body.errors?.[0];
        if (
          first?.code === 1003 &&
          first.message?.includes("maximum_stores_exceeded")
        ) {
          return yield* new secretsStore.MaximumStoresExceeded({
            code: first.code,
            message: first.message,
          });
        }
        return yield* Effect.die(
          new Error(
            `Cloudflare createStore failed (${response.status}): ${first?.message ?? "unknown error"} (code ${first?.code ?? "n/a"})`,
          ),
        );
      }
      const store = body.result!;
      return {
        result: {
          id: store.id,
          name: store.name,
          created: store.created,
          modified: store.modified,
        },
      };
    });
});

const CreateStoreEnvelope = Schema.Struct({
  success: Schema.optional(Schema.Boolean),
  errors: Schema.optional(
    Schema.Array(
      Schema.Struct({
        code: Schema.optional(Schema.Number),
        message: Schema.optional(Schema.String),
      }),
    ),
  ),
  result: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      created: Schema.String,
      modified: Schema.String,
      name: Schema.String,
    }),
  ),
});
