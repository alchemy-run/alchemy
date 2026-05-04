import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { SecretBinding } from "./SecretBinding.ts";
export type StoreSecretProps = {
  /**
   * The Secrets Store that owns this secret.
   */
  store: {
    storeId: string;
    accountId: string;
  };
  /**
   * The name of the secret within the store.
   * If omitted, the resource's logical ID is used.
   */
  name?: string;
  /**
   * The secret value. Treated as redacted and never logged.
   */
  value: Redacted.Redacted<string>;
  /**
   * Services allowed to reference this secret.
   * @default ["workers"]
   */
  scopes?: string[];
  /**
   * Optional free-form description.
   */
  comment?: string;
};

export type Secret = Resource<
  "Cloudflare.SecretsStore.Secret",
  StoreSecretProps,
  {
    secretId: string;
    secretName: string;
    storeId: string;
    accountId: string;
    status: "pending" | "active" | "deleted";
    scopes: string[];
    comment: string | undefined;
  },
  never,
  Providers
>;

/**
 * A single secret stored inside a Cloudflare Secrets Store.
 *
 * The secret value is treated as redacted and is only ever sent to
 * Cloudflare at create time. Updating `scopes` or `comment` issues a
 * PATCH; changing `value` or `name` replaces the secret.
 *
 * @section Creating a Secret
 * @example Basic Secret
 * ```typescript
 * const store = yield* Cloudflare.SecretsStore("MyStore");
 * const apiKey = yield* Cloudflare.StoreSecret("ApiKey", {
 *   store,
 *   value: Redacted.make(process.env.API_KEY!),
 * });
 * ```
 *
 * @section Binding to a Worker
 * @example Reading a secret at runtime
 * ```typescript
 * const apiKey = yield* Cloudflare.StoreSecret.bind(ApiKey);
 * // `apiKey` is itself an Effect that resolves to the secret value:
 * const value = yield* apiKey;
 * // Or call `.get()` explicitly:
 * const value = yield* apiKey.get();
 * ```
 */
export const Secret = Resource<Secret>("Cloudflare.SecretsStore.Secret")({
  bind: SecretBinding.bind,
});

const resolveScopes = (scopes: string[] | undefined): string[] =>
  scopes && scopes.length > 0 ? scopes : ["workers"];

const resolveName = (id: string, name: string | undefined): string =>
  name ?? id;

export const StoreSecretProvider = () =>
  Provider.effect(
    Secret,
    Effect.gen(function* () {
      const createStoreSecret = yield* secretsStore.createStoreSecret;
      const patchStoreSecret = yield* secretsStore.patchStoreSecret;
      const deleteStoreSecret = yield* secretsStore.deleteStoreSecret;
      const getStoreSecret = yield* secretsStore.getStoreSecret;
      const listStoreSecrets = secretsStore.listStoreSecrets;

      const arraysEqual = (a: string[], b: string[]) =>
        a.length === b.length && a.every((v, i) => v === b[i]);

      return {
        stables: ["secretId", "secretName", "storeId", "accountId"],
        diff: Effect.fn(function* ({ id, olds = {} as any, news, output }) {
          if (!isResolved(news)) return undefined;
          const oldStoreId = output?.storeId ?? olds.store?.storeId;
          const newStoreId = news.store.storeId;
          const oldName = output?.secretName ?? resolveName(id, olds.name);
          const newName = resolveName(id, news.name);
          if (oldStoreId !== newStoreId || oldName !== newName) {
            return { action: "replace" } as const;
          }
          const oldValue = olds.value ? Redacted.value(olds.value) : undefined;
          const newValue = Redacted.value(news.value);
          if (oldValue !== newValue) {
            return { action: "replace" } as const;
          }
        }),
        create: Effect.fn(function* ({ id, news }) {
          const name = resolveName(id, news.name);
          const scopes = resolveScopes(news.scopes);

          // Engine's `read` has already cleared us for adoption (foreign
          // secrets are surfaced as `Unowned` and require `--adopt`). On a
          // race between read and create, fall back to lookup-and-PATCH.
          const created = yield* createStoreSecret({
            accountId: news.store.accountId,
            storeId: news.store.storeId,
            body: [
              {
                name,
                scopes,
                value: Redacted.value(news.value),
                comment: news.comment,
              },
            ],
          }).pipe(
            Effect.catchTag("SecretNameAlreadyExists", () =>
              Effect.succeed(undefined),
            ),
          );

          if (created) {
            const secret = created.result[0]!;
            return {
              secretId: secret.id,
              secretName: secret.name,
              storeId: secret.storeId,
              accountId: news.store.accountId,
              status: secret.status,
              scopes,
              comment: secret.comment ?? undefined,
            };
          }

          // The secret already exists server-side (typically a previous
          // deploy was partially persisted). Re-fetch and reconcile
          // scopes/comment. The value cannot be read back from the API and
          // we trust an identically-named secret in the same store reflects
          // the same intent.
          const existing = yield* listStoreSecrets
            .items({
              accountId: news.store.accountId,
              storeId: news.store.storeId,
            })
            .pipe(
              Stream.filter((s) => s.name === name),
              Stream.runHead,
              Effect.map(Option.getOrUndefined),
            );

          if (!existing) {
            return yield* Effect.die(
              new Error(
                `Secret '${name}' reported as already existing in store ${news.store.storeId} but could not be found on lookup.`,
              ),
            );
          }

          // listStoreSecrets does not surface scopes, so we have no way
          // to detect drift; reconcile to the requested scopes/comment
          // unconditionally. PATCH is cheap and idempotent.
          const patched = yield* patchStoreSecret({
            accountId: news.store.accountId,
            storeId: news.store.storeId,
            secretId: existing.id,
            scopes,
            comment: news.comment,
          }).pipe(
            Effect.catchTag("SecretNotFound", () => Effect.succeed(undefined)),
          );

          return {
            secretId: existing.id,
            secretName: existing.name,
            storeId: existing.storeId,
            accountId: news.store.accountId,
            status: patched?.status ?? existing.status,
            scopes,
            comment:
              patched?.comment ?? news.comment ?? existing.comment ?? undefined,
          };
        }),
        update: Effect.fn(function* ({ news, olds = {} as any, output }) {
          const newScopes = resolveScopes(news.scopes);
          const oldScopes = resolveScopes(olds.scopes);
          const scopesChanged = !arraysEqual(newScopes, oldScopes);
          const commentChanged = (olds.comment ?? undefined) !== news.comment;
          if (!scopesChanged && !commentChanged) {
            return output;
          }
          const patched = yield* patchStoreSecret({
            accountId: output.accountId,
            storeId: output.storeId,
            secretId: output.secretId,
            scopes: scopesChanged ? newScopes : undefined,
            comment: commentChanged ? news.comment : undefined,
          });
          return {
            ...output,
            status: patched.status,
            scopes: newScopes,
            comment: patched.comment ?? undefined,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteStoreSecret({
            accountId: output.accountId,
            storeId: output.storeId,
            secretId: output.secretId,
          }).pipe(
            Effect.catchTag("SecretNotFound", () => Effect.void),
            Effect.catchTag("StoreNotFound", () => Effect.void),
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          if (output?.secretId) {
            return yield* getStoreSecret({
              accountId: output.accountId,
              storeId: output.storeId,
              secretId: output.secretId,
            }).pipe(
              Effect.map((secret) => ({
                secretId: secret.id,
                secretName: secret.name,
                storeId: secret.storeId,
                accountId: output.accountId,
                status: secret.status,
                scopes: output.scopes,
                comment: secret.comment ?? undefined,
              })),
              Effect.catchTag("SecretNotFound", () =>
                Effect.succeed(undefined),
              ),
              Effect.catchTag("StoreNotFound", () => Effect.succeed(undefined)),
            );
          }
          if (!olds?.store) return undefined;
          const name = resolveName(id, olds.name);
          const match = yield* listStoreSecrets
            .items({
              accountId: olds.store.accountId,
              storeId: olds.store.storeId,
            })
            .pipe(
              Stream.filter((s) => s.name === name),
              Stream.runHead,
              Effect.catchTag("StoreNotFound", () => Effect.succeedNone),
              Effect.map(Option.getOrUndefined),
            );
          if (!match) return undefined;
          // Secrets carry no ownership signal (Cloudflare doesn't expose
          // tags on store secrets), so a name match is not proof we own
          // it. Brand it `Unowned` so the engine surfaces
          // `OwnedBySomeoneElse` unless the caller opted in via `--adopt`.
          return Unowned({
            secretId: match.id,
            secretName: match.name,
            storeId: match.storeId,
            accountId: olds.store.accountId,
            status: match.status,
            scopes: resolveScopes(olds.scopes),
            comment: match.comment ?? undefined,
          });
        }),
      };
    }),
  );
