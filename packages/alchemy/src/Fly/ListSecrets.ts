import type {
  AppSecrets,
  SecretsListError,
} from "@distilled.cloud/fly-io/machines";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { App } from "./App.ts";

/**
 * List Fly.io App secrets. Scoped to an {@link App} — Fly's list API
 * is `GET /apps/{app}/secrets`, not a single Secret. The App is
 * fixed by `ListSecrets(app)`; calls take no `app_name`. Provide
 * {@link ListSecretsHttp} on the Action / Service Effect.
 *
 * From an Action, the org `FLY_API_TOKEN` can list any App in the
 * org — `ListSecrets(other)` is how you reach across Apps. From a
 * Machine, Fly deploy tokens are per-App: `ListSecrets(site)` on a
 * Service in `site` works; mixing Apps on one host shares one
 * `FLY_API_TOKEN` and is not supported.
 *
 * Plaintext is only returned from inside a Machine in the same App.
 *
 * @binding
 *
 * @section Listing secrets
 * @example List secrets on an App
 * ```typescript
 * const list = yield* Fly.ListSecrets(Site);
 * const { secrets } = yield* list();
 * ```
 *
 * @example List another App from an Action
 * ```typescript
 * const list = yield* Fly.ListSecrets(Other);
 * const { secrets } = yield* list();
 * ```
 */
export interface ListSecrets extends Binding.Service<
  ListSecrets,
  "Fly.ListSecrets",
  (
    app: App,
  ) => Effect.Effect<
    () => Effect.Effect<AppSecrets, SecretsListError, RuntimeContext>
  >
> {}

export const ListSecrets = Binding.Service<ListSecrets>("Fly.ListSecrets");
