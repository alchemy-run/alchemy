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
        reconcile: Effect.fn(function* ({ id, news, output }) {
          const name = resolveName(id, news.name);
          const scopes = resolveScopes(news.scopes);
          const accountId = news.store.accountId;
          const storeId = news.store.storeId;

          // Observe — re-fetch the cached secret; fall back to a name
          // scan over the store so we recover from out-of-band deletes
          // or partial state-persistence failures.
          let observed:
            | {
                id: string;
                name: string;
                storeId: string;
                status: "pending" | "active" | "deleted";
                comment?: string | null;
              }
            | undefined;
          if (output?.secretId) {
            observed = yield* getStoreSecret({
              accountId: output.accountId,
              storeId: output.storeId,
              secretId: output.secretId,
            }).pipe(
              Effect.catchTag("SecretNotFound", () =>
                Effect.succeed(undefined),
              ),
              Effect.catchTag("StoreNotFound", () => Effect.succeed(undefined)),
            );
          }
          if (!observed) {
            observed = yield* listStoreSecrets
              .items({ accountId, storeId })
              .pipe(
                Stream.filter((s) => s.name === name),
                Stream.runHead,
                Effect.catchTag("StoreNotFound", () => Effect.succeedNone),
                Effect.map(Option.getOrUndefined),
              );
          }

          // Ensure — create if missing. Cloudflare reports a concurrent
          // create as `SecretNameAlreadyExists`; tolerate by re-listing
          // the store and adopting the secret with the same name. The
          // value can't be read back from the API; we trust an
          // identically-named secret reflects the same intent.
          if (!observed) {
            const created = yield* createStoreSecret({
              accountId,
              storeId,
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
                accountId,
                status: secret.status,
                scopes,
                comment: secret.comment ?? undefined,
              };
            }
            const existing = yield* listStoreSecrets
              .items({ accountId, storeId })
              .pipe(
                Stream.filter((s) => s.name === name),
                Stream.runHead,
                Effect.map(Option.getOrUndefined),
              );
            if (!existing) {
              return yield* Effect.die(
                new Error(
                  `Secret '${name}' reported as already existing in store ${storeId} but could not be found on lookup.`,
                ),
              );
            }
            observed = existing;
          }

          // Sync — `listStoreSecrets` does not surface scopes, so we
          // can't reliably diff them. Issue PATCH only when we have a
          // record of prior props (`output`) and a difference is
          // visible; otherwise issue an unconditional PATCH on the
          // adoption / first-create path so scopes and comment converge.
          const oldScopes = output ? resolveScopes(output.scopes) : undefined;
          const scopesChanged = !oldScopes || !arraysEqual(scopes, oldScopes);
          const commentChanged =
            !output ||
            (output.comment ?? undefined) !== (news.comment ?? undefined);
          if (scopesChanged || commentChanged) {
            const patched = yield* patchStoreSecret({
              accountId,
              storeId,
              secretId: observed.id,
              scopes: scopesChanged ? scopes : undefined,
              comment: commentChanged ? news.comment : undefined,
            }).pipe(
              Effect.catchTag("SecretNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
            if (patched) {
              return {
                secretId: observed.id,
                secretName: observed.name,
                storeId: observed.storeId,
                accountId,
                status: patched.status,
                scopes,
                comment: patched.comment ?? undefined,
              };
            }
          }

          return {
            secretId: observed.id,
            secretName: observed.name,
            storeId: observed.storeId,
            accountId,
            status: observed.status,
            scopes,
            comment: news.comment ?? observed.comment ?? undefined,
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
